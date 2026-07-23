import type { InteractionContext } from "../adapters/types.ts";
import { newId } from "../event/ids.ts";
import type { AnyEventDraft, EventSource } from "../event/types.ts";
import type {
  Interaction,
  InteractionDraft,
  InteractionResolution,
} from "../interaction/types.ts";

interface InteractionBinding {
  target: { id: string };
}

type AppendEvent<TBinding> = (
  binding: TBinding,
  event: AnyEventDraft,
  source: EventSource,
) => void;

/**
 * 当前进程内的 Interaction continuation owner。持久状态仍以 opened/resolved Event
 * 为准；这里仅持有等待 resolution 的 Harness continuation。
 */
export class InteractionWaiters<TBinding extends InteractionBinding> {
  private readonly pending = new Map<
    string,
    {
      interaction: Interaction;
      binding: TBinding;
      turnId?: string;
      resolve: (resolution: InteractionResolution) => void;
    }
  >();

  constructor(
    private readonly appendEvent: AppendEvent<TBinding>,
    private readonly changed: () => void,
  ) {}

  open(
    binding: TBinding,
    draft: InteractionDraft,
    turnId: string | undefined,
    context?: InteractionContext,
  ): Promise<InteractionResolution> {
    const harnessTargetId = binding.target.id;
    const interaction: Interaction = {
      ...draft,
      interactionId: newId("ix"),
      requester: { type: "harness", harnessTargetId },
    };

    return new Promise((resolve, reject) => {
      this.pending.set(interaction.interactionId, {
        interaction,
        binding,
        turnId,
        resolve,
      });
      try {
        this.appendEvent(
          binding,
          {
            kind: "interaction.opened",
            ...(turnId ? { turnId } : {}),
            payload: interaction,
            ...(context?.raw !== undefined ? { raw: context.raw } : {}),
          },
          { type: "harness", harnessTargetId },
        );
      } catch (error) {
        this.pending.delete(interaction.interactionId);
        reject(error);
        return;
      }
      this.changed();
    });
  }

  resolve(interactionId: string, resolution: InteractionResolution): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    if (resolution.kind !== "cancelled" && resolution.kind !== entry.interaction.kind) return false;
    return this.settle(interactionId, resolution, { type: "user" });
  }

  cancelForTurn(turnId: string): void {
    for (const [interactionId, entry] of this.pending) {
      if (entry.turnId !== turnId) continue;
      this.settle(
        interactionId,
        { kind: "cancelled", reason: "turn" },
        { type: "baton" },
      );
    }
  }

  private settle(
    interactionId: string,
    resolution: InteractionResolution,
    source: EventSource,
  ): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    this.appendEvent(
      entry.binding,
      {
        kind: "interaction.resolved",
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        payload: { interactionId, resolution },
      },
      source,
    );
    this.pending.delete(interactionId);
    entry.resolve(resolution);
    return true;
  }
}

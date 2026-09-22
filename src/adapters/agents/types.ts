/**
 * Agent adapter contract. The canonical domain types live in `src/core/types.ts`;
 * this module re-exports them and adds adapter-authoring helpers.
 */
export type {
  AgentAdapter,
  AgentArtifactRef,
  AgentEvent,
  AgentEventType,
  AgentRecord,
  AgentResult,
  AgentResultStatus,
  AgentSession,
  AgentSessionStatus,
  AgentTaskConfig,
  AgentTaskPacket,
  PromptPacket,
  Usage,
} from "../../core/types.js";

import type { AgentAdapter, AgentRecord } from "../../core/types.js";

/** Resolves the adapter implementation for a configured agent. */
export type AdapterFactory = (agent: AgentRecord) => AgentAdapter | undefined;

export interface AdapterRegistry {
  register(kind: string, factory: AdapterFactory): void;
  has(kind: string): boolean;
  resolve(agent: AgentRecord): AgentAdapter | undefined;
  kinds(): string[];
}

/** Simple kind -> factory registry used by the engine's default resolver. */
export function createAdapterRegistry(
  initial: Record<string, AdapterFactory> = {},
): AdapterRegistry {
  const factories = new Map<string, AdapterFactory>(Object.entries(initial));
  return {
    register(kind, factory) {
      factories.set(kind, factory);
    },
    has(kind) {
      return factories.has(kind);
    },
    resolve(agent) {
      const factory = factories.get(agent.adapterKind);
      return factory ? factory(agent) : undefined;
    },
    kinds() {
      return [...factories.keys()].sort();
    },
  };
}

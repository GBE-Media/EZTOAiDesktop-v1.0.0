import { registerAssistantTools } from '../../tools/registry';
import { createTakeoffDomainTools } from './takeoffTools';
import { createEstimatingStubTools } from './estimatingTools';

let registered = false;

/**
 * How to add a new BidveraAi agent tool later:
 * 1. Define Zod schema + risk (`read` | `write` | `destructive` | `external`) + requiresConfirmation + optional verifyWith.
 * 2. Implement a real handler (store/service call) or a stub that returns status "stub" (never fake success).
 * 3. Export it from takeoffTools.ts / estimatingTools.ts (or a new module) and include it in registerAllAgentTools().
 * 4. Update system prompt policy only if behavior rules change — prefer encoding rules in code.
 * 5. Add a registry/unit test covering validation + approval behavior.
 */
export function registerAllAgentTools(): void {
  if (registered) return;
  registerAssistantTools([
    ...createTakeoffDomainTools(),
    ...createEstimatingStubTools(),
  ]);
  registered = true;
}

/** Test helper to allow re-registration in unit tests. */
export function resetAgentToolRegistrationForTests(): void {
  registered = false;
}

/**
 * Muse resources — thin re-exports of the contracts schemas, so
 * browser code validates against the same single source of truth
 * as the server instead of a second, shadowing copy.
 */
export {
  AgentKeyCreateSchema,
  AgentKeyCreateResponseSchema,
  AgentKeyListResponseSchema,
  AgentKeySchema,
  MuseActivityResponseSchema,
  type AgentKey,
  type AgentKeyCreate,
  type AgentKeyCreateResponse,
  type AgentKeyListResponse,
  type MuseActivityResponse,
} from '@fbuploadpro/contracts';

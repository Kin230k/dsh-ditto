/**
 * DSH plugin entry: `import DshDitto from 'dsh-ditto/dsh'` (also referenced by
 * cordis.patch.yml as `dsh-ditto/dsh`). The class is a Cordis service; mount it
 * with `ctx.plugin(DshDitto, config)`.
 */
export { DshDitto, assertSpecIdentity, type PlanView, type SpecBatchView } from './service.js'
export { DEFAULT_CONFIG, resolveConfig, type DshDittoConfig, type ResolvedConfig } from './config.js'
export { SKILL_FILE, dittoSkill, parseSkillFile } from './skill.js'
export { TOOL_CATALOG, TOOL_NAMES, type ToolFact } from './catalog.js'
export { requireHumanApproval, type ApprovalLike, type ApprovalSource } from './tools/shared.js'
import { DshDitto } from './service.js'
export default DshDitto

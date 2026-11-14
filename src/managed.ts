/** The schema of the plugin configuration's `managed` block; kept free of app imports, as deployment.ts loads it. */
import { z } from 'zod'

/** The team prompt sections, as `TEAM_SECTIONS` in src/app/prompts.ts names them. */
export const MANAGED_SECTIONS = ['communication', 'scope', 'delivery'] as const
const Section = z.union([z.string(), z.object({ append: z.string() }).strict()])
/** Keys a deployment manages, merged over each stored block and saved like a panel save; keys left out stay editable. */
export const ManagedSchema = z.object({
  sources: z.record(z.string(), z.object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }).strict()).optional(),
  policy: z.object({ rules: z.array(z.unknown()).optional(), sources: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict().optional(),
  eval: z.record(z.string(), z.unknown()).optional(),
  executor: z.record(z.string(), z.unknown()).optional(),
  prompts: z.object({ ...Object.fromEntries(MANAGED_SECTIONS.map(section => [section, Section.optional()])) as Record<typeof MANAGED_SECTIONS[number], z.ZodOptional<typeof Section>>,
    skills: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string()).optional() }).strict().optional(),
}).strict()
export type Managed = z.infer<typeof ManagedSchema>


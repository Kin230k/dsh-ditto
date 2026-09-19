import { assertPlanShape, withDigest } from './plan.js'
import { isSafeId, validateRecipe } from './recipe.js'
import { atomicWriteStateText, listStateLeaves, readStateText } from './state-paths.js'
import type { Plan, Recipe } from './types.js'

const PLANS = 'plans'
const RECIPES = 'recipes'

export async function savePlan(plan: Plan, stateRoot: string): Promise<void> {
  assertPlanShape(plan)
  if (withDigest({ ...plan, digest: '' }).digest !== plan.digest) throw new Error('Plan review digest is invalid')
  await atomicJson(stateRoot, PLANS, `${plan.id}.json`, plan)
}

export async function loadPlan(planId: string, stateRoot: string): Promise<Plan> {
  if (!isSafeId(planId)) throw new Error('Invalid plan ID')
  const plan = parseJson(await readStateText(stateRoot, PLANS, `${planId}.json`), 'plan') as Plan
  assertPlanShape(plan)
  if (withDigest({ ...plan, digest: '' }).digest !== plan.digest) throw new Error('Saved plan failed review-integrity validation')
  // Summary and diagnostics are derived state, never trusted persisted claims.
  return withDigest({ ...plan, digest: '' })
}

export async function saveRecipe(recipe: Recipe, stateRoot: string): Promise<void> {
  validateRecipe(recipe)
  await atomicJson(stateRoot, RECIPES, `${recipe.id}.json`, recipe)
}

export async function loadRecipe(recipeId: string, stateRoot: string): Promise<Recipe> {
  if (!isSafeId(recipeId)) throw new Error('Invalid recipe ID')
  const recipe = parseJson(await readStateText(stateRoot, RECIPES, `${recipeId}.json`), 'recipe') as Recipe
  validateRecipe(recipe)
  return recipe
}

export async function listRecipes(stateRoot: string): Promise<Array<Pick<Recipe, 'id' | 'name' | 'version' | 'createdAt'>>> {
  try {
    const names = await listStateLeaves(stateRoot, RECIPES)
    const recipes = await Promise.all(names.filter(name => /^[0-9a-f-]{16,64}\.json$/i.test(name)).map(async name => {
      const id = name.slice(0, -5)
      try {
        const recipe = await loadRecipe(id, stateRoot)
        return { id: recipe.id, name: recipe.name, version: recipe.version, createdAt: recipe.createdAt }
      } catch (error: unknown) {
        throw new Error(`Saved recipe ${id} could not be listed: ${error instanceof Error ? error.message : 'invalid recipe'}`)
      }
    }))
    return recipes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function atomicJson(stateRoot: string, category: string, leaf: string, value: unknown): Promise<void> {
  await atomicWriteStateText(stateRoot, category, leaf, `${JSON.stringify(value, null, 2)}\n`)
}

function parseJson(input: string, kind: string): unknown {
  try { return JSON.parse(input) } catch { throw new Error(`Saved ${kind} is not valid JSON`) }
}

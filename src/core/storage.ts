import { mkdir, readFile, rename, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertPlanShape, withDigest } from './plan.js'
import { isSafeId, validateRecipe } from './recipe.js'
import type { Plan, Recipe } from './types.js'

const PLANS = 'plans'
const RECIPES = 'recipes'

export async function savePlan(plan: Plan, stateRoot: string): Promise<void> {
  assertPlanShape(plan)
  if (withDigest({ ...plan, digest: '' }).digest !== plan.digest) throw new Error('Plan review digest is invalid')
  await atomicJson(join(stateRoot, PLANS, `${plan.id}.json`), plan)
}

export async function loadPlan(planId: string, stateRoot: string): Promise<Plan> {
  if (!isSafeId(planId)) throw new Error('Invalid plan ID')
  const plan = parseJson(await readFile(stateFile(stateRoot, PLANS, planId), 'utf8'), 'plan') as Plan
  assertPlanShape(plan)
  if (withDigest({ ...plan, digest: '' }).digest !== plan.digest) throw new Error('Saved plan failed review-integrity validation')
  return plan
}

export async function saveRecipe(recipe: Recipe, stateRoot: string): Promise<void> {
  validateRecipe(recipe)
  await atomicJson(join(stateRoot, RECIPES, `${recipe.id}.json`), recipe)
}

export async function loadRecipe(recipeId: string, stateRoot: string): Promise<Recipe> {
  if (!isSafeId(recipeId)) throw new Error('Invalid recipe ID')
  const recipe = parseJson(await readFile(stateFile(stateRoot, RECIPES, recipeId), 'utf8'), 'recipe') as Recipe
  validateRecipe(recipe)
  return recipe
}

export async function listRecipes(stateRoot: string): Promise<Array<Pick<Recipe, 'id' | 'name' | 'version' | 'createdAt'>>> {
  const folder = join(resolve(stateRoot), RECIPES)
  try {
    const names = await readdir(folder)
    const recipes = await Promise.all(names.filter(name => /^[0-9a-f-]{16,64}\.json$/i.test(name)).map(async name => {
      try { const recipe = await loadRecipe(name.slice(0, -5), stateRoot); return { id: recipe.id, name: recipe.name, version: recipe.version, createdAt: recipe.createdAt } } catch { return undefined }
    }))
    return recipes.filter((recipe): recipe is Pick<Recipe, 'id' | 'name' | 'version' | 'createdAt'> => recipe !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function stateFile(stateRoot: string, category: string, id: string): string {
  const root = resolve(stateRoot)
  const file = resolve(root, category, `${id}.json`)
  if (!file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) throw new Error('Invalid state path')
  return file
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, file)
}

function parseJson(input: string, kind: string): unknown {
  try { return JSON.parse(input) } catch { throw new Error(`Saved ${kind} is not valid JSON`) }
}

import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { registerExcalidrawCommands } from '../src/commands'

const options = { strict: false, strictSchema: true, allErrors: true, validateFormats: false, allowUnionTypes: true, ownProperties: true }

function compileLikeValley(schema: Record<string, unknown>) {
  let nodes = 0
  const active = new Set<object>()
  const visited = new WeakSet<object>()
  const resolve = (reference: string): unknown => {
    if (reference === '#') return schema
    if (!reference.startsWith('#/')) throw new Error('Command schemas cannot load remote references')
    return reference.slice(2).split('/').reduce<unknown>((value, part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('Command schema reference is invalid')
      return (value as Record<string, unknown>)[key]
    }, schema)
  }
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 32) throw new Error('Command schema complexity exceeds its limit')
    if (!value || typeof value !== 'object') return
    if (active.has(value)) throw new Error('Recursive command schemas are not supported')
    if (visited.has(value)) return
    active.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') visit(resolve(child as string), depth + 1)
      else if (key === '$dynamicRef' || key === '$recursiveRef') throw new Error('Dynamic command schema references are not supported')
      else visit(child, depth + 1)
    }
    active.delete(value)
    visited.add(value)
  }
  expect(Buffer.byteLength(JSON.stringify(schema), 'utf8')).toBeLessThanOrEqual(65_536)
  visit(schema, 0)
  new Ajv2020(options).validateSchema(schema, true)
  return new Ajv2020({ ...options, validateSchema: false }).compile(structuredClone(schema))
}

describe('excalidraw command schemas', () => {
  it('compile under the host command schema rules and accept arbitrary customData JSON', () => {
    const mock = createMockValleyApi({ manifest: { id: 'excalidraw' } })
    const registrations = vi.spyOn(mock.api.commands, 'register')
    const off = registerExcalidrawCommands(mock.api)
    try {
      const commands = registrations.mock.calls.map(([value]) => value as typeof value & { outputSchema: Record<string, unknown> })
      for (const command of commands) expect(() => compileLikeValley(command.outputSchema), command.id).not.toThrow()
      const validate = compileLikeValley(commands.find(command => command.id === 'get')!.outputSchema)
      const customData = { text: 'Canopy', count: 3, flag: true, none: null, list: [1, 'two', { three: [null] }], nested: { deep: { deeper: ['x'] } } }
      expect(validate({ path: 'Board.excalidraw', revision: '{}', view: null, scene: { elements: [{ id: 'fern', type: 'rectangle', customData }] } }), JSON.stringify(validate.errors)).toBe(true)
      expect(validate({ path: 'Board.excalidraw', revision: '{}', view: null, scene: { elements: [{ id: 'fern', type: 'rectangle', customData: [] }] } })).toBe(false)
    } finally { off() }
  })
})

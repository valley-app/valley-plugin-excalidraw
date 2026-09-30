import type { ValleyPluginApi } from '@valley/plugin-sdk'

export let React!: typeof import('react')
export let api!: ValleyPluginApi

export function initRuntime(a: ValleyPluginApi): void {
  api = a
  React = a.React
}

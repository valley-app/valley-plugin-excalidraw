import { registerWorkflowCommands, type PluginBackendApi, type WorkflowCommandBinding, type WorkflowContributionContract } from '@valley/plugin-sdk'
import config from '../../config.json'

export const bindings: WorkflowCommandBinding[] = [
  {
    "nodeId": "excalidraw.create",
    "command": "excalidraw:create",
    "schemaFingerprint": "6869b54879f68f726633f617d49f6ee2daf49967e3dde30a7b21e5512c7ab528",
    "effect": "write"
  },
  {
    "nodeId": "excalidraw.get",
    "command": "excalidraw:get",
    "schemaFingerprint": "0019fb74431c69f98bcf6b8b2302577e49fdfee59b5f767c63f83acf2f93983e",
    "effect": "read"
  },
  {
    "nodeId": "excalidraw.scene-update",
    "command": "excalidraw:scene-update",
    "schemaFingerprint": "3ff5d4fdcae499635a90c99980da88578e5dd869f77e441654b2ca961f641b2e",
    "effect": "write"
  }
]

export function register(api: PluginBackendApi): () => void {
  const contribution = config.runtime.services.find(service => service.id === 'workflow.provider')!
  const registration = registerWorkflowCommands(api, contribution.metadata!.workflow as unknown as WorkflowContributionContract, bindings)
  return () => registration.dispose()
}

export const nativeLibraryVersion: string
export const nativeLibraryHash: string
export function patchNativeActions(source: string, version: string, bridgePath: string): string
export const nativeEffectSources: Record<string, { version: string; hash: string }>
export function patchNativeEffects(source: string, name: string, version: string): string

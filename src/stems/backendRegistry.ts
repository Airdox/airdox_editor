import type { IStemSeparator } from './backends/types';

export class BackendRegistry {
  private readonly backends = new Map<string, IStemSeparator>();

  register(backend: IStemSeparator): void {
    this.backends.set(backend.backendId, backend);
  }

  get(id: string): IStemSeparator | undefined {
    return this.backends.get(id);
  }

  list(): IStemSeparator[] {
    return [...this.backends.values()];
  }

  has(id: string): boolean {
    return this.backends.has(id);
  }
}

export function createBackendRegistry(backends: IStemSeparator[] = []): BackendRegistry {
  const registry = new BackendRegistry();
  for (const backend of backends) registry.register(backend);
  return registry;
}

import { createRequire } from 'module';

const packageJson = createRequire(import.meta.url)('./package.json') as { version: string };

/** The `serverInfo` of an `initialize` result, shared by the HTTP and stdio transports. */
export function buildServerInfo(name: string, publicUrl?: string) {
  return {
    name,
    title: 'Komplyt Zero',
    version: packageJson.version,
    iconUrl: publicUrl ? `${publicUrl}/icon.png` : undefined,
  };
}

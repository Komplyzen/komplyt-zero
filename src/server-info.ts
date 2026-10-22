import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * package.json sits next to the code in the source tree and the container image (`dist/package.json`),
 * and one level up in the npm package, where the code is in `dist/`.
 */
function packageVersion(): string {
  for (const path of ['./package.json', '../package.json']) {
    try {
      return (require(path) as { version: string }).version;
    } catch {
      /* try the next location */
    }
  }
  throw new Error('package.json not found next to the server code');
}

const version = packageVersion();

/** The `serverInfo` of an `initialize` result, shared by the HTTP and stdio transports. */
export function buildServerInfo(name: string, publicUrl?: string) {
  return {
    name,
    title: 'Komplyt Zero',
    version,
    iconUrl: publicUrl ? `${publicUrl}/icon.png` : undefined,
  };
}

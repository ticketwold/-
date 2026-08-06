type Level = 'debug' | 'info' | 'warn' | 'error';

const PREFIX = '[ArbScanner]';

export function createLogger(scope: string) {
  const tag = `${PREFIX}/${scope}`;

  const log = (level: Level, msg: string, data?: unknown) => {
    const line = `${tag} ${msg}`;
    try {
      if (level === 'error') console.error(line, data ?? '');
      else if (level === 'warn') console.warn(line, data ?? '');
      else if (level === 'debug') console.debug(line, data ?? '');
      else console.log(line, data ?? '');
    } catch {
      /* extension context invalidated */
    }
  };

  return {
    debug: (m: string, d?: unknown) => log('debug', m, d),
    info: (m: string, d?: unknown) => log('info', m, d),
    warn: (m: string, d?: unknown) => log('warn', m, d),
    error: (m: string, d?: unknown) => log('error', m, d),
    catch: (m: string, err: unknown) =>
      log('error', m, err instanceof Error ? err.message : String(err)),
  };
}

export const logger = createLogger('core');

// Makes the bin executable (tsc preserves the shebang but not the file mode).
import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/index.js', import.meta.url), 0o755);

import { ANNOTATIONS, defineGated, ok } from './_structureKit.js';
import type { ToolGroup } from './_shared.js';

export const registerCompanyTools: ToolGroup = (server, deps) => {
  // Spec path is `/companies{*companyId}`; `/companies` is unverified live (ARCHITECTURE §10 risk 1).
  defineGated(
    server,
    deps,
    'read',
    'yougile_get_company',
    {
      title: 'Get company',
      description: 'Return the company of the configured API key (id, title, timestamp).',
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    async (_args, extra) =>
      ok(await deps.client.request('GET', '/companies', { signal: extra.signal })),
  );
};

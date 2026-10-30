// One Eve process serves one role. AGENT_ROLE selects the system prompt in promts/.
export const rolePromptFiles: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), {
 invoice: 'invoice_investigator.txt',
 wallet: 'wallet_investigator.txt',
 supplier: 'supplier_investigator.txt',
 main: 'main_agent_prompt.txt',
}));

export const agentRoles: readonly string[] = Object.freeze(Object.keys(rolePromptFiles));

export function resolveRole(value: string | undefined): string {
 const role = value?.trim();
 if (!role) throw new Error(`AGENT_ROLE is required: set it to one of ${agentRoles.join(', ')}`);
 if (!Object.hasOwn(rolePromptFiles, role)) throw new Error(`AGENT_ROLE must be one of ${agentRoles.join(', ')}; got ${JSON.stringify(role.slice(0, 40))}`);
 return role;
}

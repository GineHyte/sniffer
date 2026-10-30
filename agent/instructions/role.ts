import { defineInstructions } from 'eve/instructions';
import { resolveRole } from '../lib/role.ts';
import invoice from '../../promts/invoice_investigator.txt?raw';
import wallet from '../../promts/wallet_investigator.txt?raw';
import supplier from '../../promts/supplier_investigator.txt?raw';
import main from '../../promts/main_agent_prompt.txt?raw';

// Static system instructions. Eve resolves them once when it compiles the agent,
// so restart the Eve process after changing AGENT_ROLE.
const prompts: Record<string, string> = { invoice, wallet, supplier, main };
const role = resolveRole(process.env.AGENT_ROLE);
const content = prompts[role];
if (typeof content !== 'string' || !content.trim()) throw new Error(`Prompt for AGENT_ROLE ${role} is empty`);

export default defineInstructions({ content });

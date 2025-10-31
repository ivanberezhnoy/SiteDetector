import fs from 'node:fs';
import path from 'node:path';


export type NotifState = {
// siteId → lastProblemNotified: true/false
notified: Record<string, boolean>;
};


const statePath = path.join(process.cwd(), 'data', 'state.json');


export function loadState(): NotifState {
try {
const txt = fs.readFileSync(statePath, 'utf-8');
return JSON.parse(txt);
} catch {
return { notified: {} };
}
}


export function saveState(state: NotifState) {
fs.mkdirSync(path.dirname(statePath), { recursive: true });
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
import fs from 'node:fs';
import path from 'node:path';
import { AppConfig } from './types.ts';


const ROOT = path.resolve(process.cwd());
const CONFIG_PATH = path.join(ROOT, 'config', 'sites.json');


function withDefaults(site: Site): Site 
{
	(site as any).disabled = site.disabled ?? false;

	const urls = (site as any).myAdsUrls ?? [];
	(site as any).myAdsUrls = Array.from(
	new Set(
	  urls
	    .map(u => (typeof u === 'string' ? u.trim() : ''))
	    .filter(Boolean)
	)
	);
	
	return site;
}

export function loadConfig(): AppConfig 
{
	const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
	const cfg: AppConfig = JSON.parse(raw);
	cfg.sites = cfg.sites.map(withDefaults);
	return cfg;
}
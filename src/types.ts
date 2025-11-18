export type MonitorSite = {
type: 'monitor';
disabled?: bool;
id: string;
periodSec: number;
listUrl: string;
adLinkSelector?: string; // CSS selector для входа в первое объявление
phoneSelector: string; // CSS селектор телефона внутри карточки объявления
showPhoneSelector?: string;
myAdsUrls?: string | string[];
phoneDialogSelectors? string[];
adClick?: { navigate?: boolean; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' };
refreshBrowserData?: bool;
};


export type LoginConfig = {
url: string;
usernameSelector: string;
passwordSelector: string;
submitSelector?: string;
username: string;
password: string;
twoFactorSelector?: string; // если нужно
openSelector?: string;
openClickNavigates?: boolean;
};


export type BumpSite = {
type: 'bump';
id: string;
disabled?: bool;
periodSec: number;
login: LoginConfig;
myAdsUrls?: string[];
function: string; // имя функции из реестра
bumpSelector?: string; 
bumpFunction?: string;
bumpSleepSec?: number;
refreshBrowserData?: bool;
};


export type Site = MonitorSite | BumpSite;


export type AppConfig = {
phones: string[]; // список "моих" телефонов
sites: Site[];
};
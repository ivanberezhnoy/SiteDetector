export function normalizePhone(input: string): string {
return input.replace(/[^0-9+]/g, '')
.replace(/^\+?38(0\d{9})$/, '+38$1')
.replace(/^(0\d{9})$/, '+38$1');
}


export function phonesSet(phones: string[]): Set<string> {
return new Set(phones.map(normalizePhone));
}
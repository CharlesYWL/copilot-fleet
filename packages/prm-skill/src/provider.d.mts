import type { HelperInput, ParsedPrUrl, ProviderResult } from "./engine.js";

export declare function parsePrUrl(url: string): ParsedPrUrl;
export declare function observePr(input: HelperInput): Promise<ProviderResult>;

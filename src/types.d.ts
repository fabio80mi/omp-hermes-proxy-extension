declare module "@oh-my-pi/pi-ai" {
  export function streamSimple(model: any, context: any, options?: any): any;
  export function registerCustomApi(id: string, api: any): void;
  export const type: string;
}

declare module "@oh-my-pi/pi-coding-agent" {
  export type ExtensionAPI = any;
  export default function (pi: ExtensionAPI): void;
}

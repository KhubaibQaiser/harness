declare const __HARNESS_VERSION__: string; // injected by build.mjs; undefined when tests import the source
export const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0-dev';
/** npx for this exact version: a bare `npx @khubaibqaiser/harness` runs npm's `latest` tag, which can be older. */
export const NPX = `npx @khubaibqaiser/harness@${VERSION}`;

/**
 * Lets node --experimental-strip-types run app modules that import siblings
 * without an extension (`./types`), the way Vite resolves them.
 *
 *   node --import ./tests/ts-resolve.mjs --experimental-strip-types tests/x.test.ts
 */
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try {
    return await next(spec, ctx);
  } catch (err) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.[cm]?[jt]sx?$/.test(spec)) {
      return next(spec + ".ts", ctx);
    }
    throw err;
  }
}`),
);

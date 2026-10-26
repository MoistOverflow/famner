// Loaded before the tests (node --import ./tests/setup.js): lets plain Node understand SvelteKit's
// `$lib/…` and `$env/dynamic/private` imports, so server code can be tested without building.
import { registerHooks } from 'node:module';

// dates in the tests are written for this time zone, so results are the same on every machine
process.env.TZ = 'America/New_York';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const lib = pathToFileURL(resolvePath('src/lib') + '/').href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier.startsWith('$lib/')) return next(lib + specifier.slice(5), context);
		if (specifier === '$env/dynamic/private')
			return { url: 'famner-env:private', shortCircuit: true };
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === 'famner-env:private') {
			return { format: 'module', source: 'export const env = process.env;', shortCircuit: true };
		}
		return next(url, context);
	}
});

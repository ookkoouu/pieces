import { isNullish } from '@sapphire/utilities';
import { readFileSync } from 'fs';
import { basename, dirname, extname, resolve } from 'path';
import { pathToFileURL } from 'url';
import { MissingExportsError } from '../errors/MissingExportsError';
import { mjsImport } from '../internal/internal';
import { getRootData } from '../internal/RootScan';
import type { Piece } from '../structures/Piece';
import type { Store } from '../structures/Store';
import type { AsyncPreloadResult, FilterResult, ILoaderResult, ILoaderResultEntry, ILoaderStrategy, ModuleData } from './ILoaderStrategy';
import { classExtends, isClass } from './Shared';

async function listRequires(filepath: string): string[] {
	filepath = resolve(filepath);
	if (!filepath.endsWith('js')) return [];
	const fileContent = readFileSync(filepath).toString();
	const moduleNames = [...fileContent.matchAll(/(require\(["'])(.+?)(["']\))/g)].map((m) => m[2]);
	const modulePaths = moduleNames
		.map((n) => require.resolve(n, { paths: [dirname(filepath)] }))
		.filter((p) => p.match(/\.(cjs|mjs|js)$/) && !p.includes('node_modules'));
	return modulePaths;
}

/**
 * A multi-purpose feature-complete loader strategy supporting multi-piece modules as well as supporting both ECMAScript
 * Modules and CommonJS with reloading support.
 */
export class LoaderStrategy<T extends Piece> implements ILoaderStrategy<T> {
	public clientUsesESModules = getRootData().type === 'ESM';
	public supportedExtensions = ['.js', '.cjs', '.mjs'];
	private readonly filterDtsFiles: boolean = false;

	public constructor() {
		/**
		 * If {@linkplain https://github.com/TypeStrong/ts-node ts-node} is being used
		 * we conditionally need to register files ending in the `.ts` file extension.
		 *
		 * This is because `ts-node` builds files into memory, so we have to scan the
		 * source `.ts` files, rather than files emitted with any of the JavaScript
		 * extensions.
		 */
		if (Reflect.has(process, Symbol.for('ts-node.register.instance')) || !isNullish(process.env.TS_NODE_DEV)) {
			this.supportedExtensions.push('.ts', '.cts', '.mts');
			this.filterDtsFiles = true;
		}
	}

	public filter(path: string): FilterResult {
		// Retrieve the file extension.
		const extension = extname(path);
		if (!this.supportedExtensions.includes(extension)) return null;

		if (this.filterDtsFiles && path.endsWith('.d.ts')) return null;

		// Retrieve the name of the file, return null if empty.
		const name = basename(path, extension);
		if (name === '') return null;

		// Return the name and extension.
		return { extension, path, name };
	}

	public async preload(file: ModuleData): AsyncPreloadResult<T> {
		const mjs = ['.mjs', '.mts'].includes(file.extension) || (['.js', '.ts'].includes(file.extension) && this.clientUsesESModules);
		if (mjs) {
			const url = pathToFileURL(file.path);
			url.searchParams.append('d', Date.now().toString());
			url.searchParams.append('name', file.name);
			url.searchParams.append('extension', file.extension);
			return mjsImport(url);
		}

		for (const modulePath of await listRequires(file.path)) {
			delete require.cache[modulePath];
		}

		delete require.cache[require.resolve(file.path)];
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require(file.path);
		return mod;
	}

	public async *load(store: Store<T>, file: ModuleData): ILoaderResult<T> {
		let yielded = false;
		const result = await this.preload(file);

		// Support `module.exports`:
		if (isClass(result) && classExtends(result, store.Constructor)) {
			yield result;
			yielded = true;
		}

		// Support any other export:
		for (const value of Object.values(result)) {
			if (isClass(value) && classExtends(value, store.Constructor)) {
				yield value as ILoaderResultEntry<T>;
				yielded = true;
			}
		}

		if (!yielded) {
			throw new MissingExportsError(file.path);
		}
	}

	public onLoad(): unknown {
		return undefined;
	}

	public onLoadAll(): unknown {
		return undefined;
	}

	public onUnload(): unknown {
		return undefined;
	}

	public onUnloadAll(): unknown {
		return undefined;
	}

	public onError(error: Error, path: string): void {
		console.error(`Error when loading '${path}':`, error);
	}
}

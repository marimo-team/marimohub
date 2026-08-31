import { BadRequestError, NotFoundError } from '../../../errors';
import type { SurfaceId, SurfaceSpec } from './types';

export class SurfaceRegistry {
	private readonly specs = new Map<SurfaceId, SurfaceSpec>();

	constructor(specs: readonly SurfaceSpec[]) {
		for (const spec of specs) {
			if (this.specs.has(spec.id)) throw new BadRequestError(`Duplicate surface: ${spec.id}`);
			this.specs.set(spec.id, spec);
		}
		const primary = specs.filter((spec) => spec.primary);
		if (primary.length !== 1) {
			throw new BadRequestError('A surface registry requires exactly one primary surface');
		}
	}

	get(id: SurfaceId): SurfaceSpec {
		const spec = this.specs.get(id);
		if (!spec) throw new NotFoundError(`Surface ${id} is not registered`);
		return spec;
	}

	list(): SurfaceSpec[] {
		return [...this.specs.values()];
	}
}

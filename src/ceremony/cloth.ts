import * as THREE from 'three';

// Mass-spring cloth model adapted from FlagWaver (MIT):
// https://github.com/krikienoid/flagwaver
const TIME_STEP = 1 / 60;
const ITERATION_COUNT = 2;
const DRAG = 0.97;
const DRAG_COEFFICIENT = 0.12;
const AIR_DENSITY = 1.225;
const GRAVITY = 9.80665;
// FlagWaver's wind control maps to a fairly ordinary outdoor wind range;
// keep the normalized UI value from producing unrealistically strong wind.
const MAX_WIND_SPEED = 18;
export interface WindParameters {
  strength: number;
  direction: number;
  gustiness: number;
  turbulence: number;
  phase: number;
  time: number;
  /** Physics-only outward tension envelope, zero before wind pickup. */
  unfurl: number;
}
export type ClothSnapshot = {
  width: number;
  height: number;
  widthSegments: number;
  heightSegments: number;
  positions: number[];
  previous: number[];
};
export type SelfCollisionOptions = {
  selfCollision: boolean;
  collisionThickness: number;
  collisionIterations: 1 | 2;
};
const SURFACE_MASS = 0.11;
const DEFAULT_SELF_COLLISION_OPTIONS: SelfCollisionOptions = {
  selfCollision: true,
  collisionThickness: 0.2,
  collisionIterations: 2,
};

class Particle {
  readonly position: THREE.Vector3;
  readonly previous: THREE.Vector3;
  readonly original: THREE.Vector3;
  readonly inverseMass: number;
  readonly acceleration = new THREE.Vector3();
  private temporary = new THREE.Vector3();

  constructor(position: THREE.Vector3, mass: number) {
    this.position = position.clone();
    this.previous = position.clone();
    this.original = position.clone();
    this.inverseMass = 1 / mass;
  }

  applyForce(force: THREE.Vector3): void {
    this.acceleration.addScaledVector(force, this.inverseMass);
  }

  integrate(): void {
    const next = this.temporary
      .subVectors(this.position, this.previous)
      .multiplyScalar(DRAG)
      .add(this.position)
      .addScaledVector(this.acceleration, TIME_STEP * TIME_STEP);
    this.previous.copy(this.position);
    this.position.copy(next);
    this.acceleration.set(0, 0, 0);
  }

  reset(): void {
    this.position.copy(this.original);
    this.previous.copy(this.original);
    this.temporary.copy(this.original);
    this.acceleration.set(0, 0, 0);
  }
}

class Constraint {
  private readonly difference = new THREE.Vector3();

  constructor(
    private readonly first: Particle,
    private readonly second: Particle,
    private readonly restDistance: number
  ) {}

  resolve(): void {
    this.difference.subVectors(this.second.position, this.first.position);
    const distance = this.difference.length();
    if (distance === 0) return;
    const correction = this.difference.multiplyScalar((1 - this.restDistance / distance) / 2);
    this.first.position.add(correction);
    this.second.position.sub(correction);
  }
}

class FixedConstraint {
  private readonly difference = new THREE.Vector3();

  constructor(
    private readonly fixed: Particle,
    private readonly moving: Particle,
    private readonly restDistance: number
  ) {}

  resolve(): void {
    // A flag is cloth, not a rigid sheet. Allow generous sag while it is
    // being hoisted; wind will gradually pull these links taut later.
    const slackDistance = this.restDistance * 1.55;
    this.difference.subVectors(this.fixed.position, this.moving.position);
    const distance = this.difference.length();
    if (distance <= slackDistance || distance === 0) return;
    this.moving.position.add(this.difference.multiplyScalar((distance - slackDistance) / distance));
  }
}

class AttachmentConstraint {
  private readonly difference = new THREE.Vector3();

  constructor(
    private readonly fixed: Particle,
    private readonly moving: Particle,
    private readonly restDistance: number
  ) {}

  resolve(): void {
    this.difference.subVectors(this.moving.position, this.fixed.position);
    const distance = this.difference.length();
    if (distance < 1e-7) {
      this.moving.position.set(this.fixed.position.x + this.restDistance, this.fixed.position.y, this.fixed.position.z);
      return;
    }
    this.moving.position.copy(this.fixed.position).addScaledVector(this.difference, this.restDistance / distance);
  }
}

export class ClothSimulation {
  readonly geometry: THREE.BufferGeometry;
  readonly fixedStep = TIME_STEP;
  private readonly particles: Particle[] = [];
  private readonly constraints: Constraint[] = [];
  private readonly lengthConstraints: FixedConstraint[] = [];
  private readonly attachmentConstraints: AttachmentConstraint[] = [];
  private readonly luffGuides: Array<{ particle: Particle; x: number; y: number; z: number }> = [];
  private readonly pins: Particle[] = [];
  private readonly pinnedParticles = new Set<Particle>();
  private readonly indices: number[] = [];
  private readonly gravity = new THREE.Vector3();
  private readonly windPressure = new THREE.Vector3();
  private readonly unfurlForce = new THREE.Vector3();
  private readonly collisionCorrection = new THREE.Vector3();
  private readonly faceNormal = new THREE.Vector3();
  private readonly edgeA = new THREE.Vector3();
  private readonly edgeB = new THREE.Vector3();
  private readonly widthSegments: number;
  private readonly heightSegments: number;
  private readonly restX: number;
  private readonly restY: number;
  private readonly faceArea: number;
  private readonly collisionHash = new Map<string, number[]>();
  private readonly collisionBucketPool: number[][] = [];
  private selfCollisionOptions: SelfCollisionOptions;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly seed = 0,
    resolution: 'standard' | 'high' | 'ultra' = 'standard',
    options: SelfCollisionOptions = DEFAULT_SELF_COLLISION_OPTIONS
  ) {
    this.selfCollisionOptions = this.normalizeSelfCollisionOptions(options);
    const density = resolution === 'ultra' ? 0.08 : resolution === 'high' ? 0.12 : 0.2;
    // Higher density produces smoother silhouettes, at a predictable GPU cost.
    this.widthSegments = Math.max(10, Math.min(160, Math.round(width / density)));
    this.heightSegments = Math.max(7, Math.min(100, Math.round(height / density)));
    this.restX = width / this.widthSegments;
    this.restY = height / this.heightSegments;
    this.faceArea = this.restX * this.restY / 2;
    const particleMass = SURFACE_MASS * width * height / ((this.widthSegments + 1) * (this.heightSegments + 1));
    const positions: number[] = [];
    const uvs: number[] = [];

    for (let row = 0; row <= this.heightSegments; row += 1) {
      for (let column = 0; column <= this.widthSegments; column += 1) {
        // Accordion-folded start pose: the projected width is compressed while
        // alternating depth preserves each segment's rest length. Gravity can
        // therefore produce a genuinely limp, wrinkled flag before wind picks up.
        // Keep a visible fold without hiding most of the cloth: 75% projected
        // width gives a relaxed accordion, while this depth preserves rest
        // length exactly for alternating adjacent folds.
        const projected = this.restX * 0.75;
        const foldDepth = Math.sqrt(Math.max(0, this.restX * this.restX - projected * projected)) / 2;
        const foldSign = ((column + Math.floor(this.seed)) % 2 === 0 ? 1 : -1);
        const position = new THREE.Vector3(column * projected, -row * this.restY, foldSign * foldDepth);
        this.particles.push(new Particle(position, particleMass));
        positions.push(position.x, position.y, position.z);
        uvs.push(column / this.widthSegments, 1 - row / this.heightSegments);
        if (column === 0 && (row === 0 || row === this.heightSegments)) {
          const pin = this.particleAt(column, row);
          this.pins.push(pin);
          this.pinnedParticles.add(pin);
        }
      }
    }

    // A reinforced luff hem hangs in a shallow arc between two rope points.
    // It is guided rather than fully pinned, so the rest of the cloth remains free.
    const luffArcDepth = Math.min(width * 0.008, height * 0.012);
    for (let row = 1; row < this.heightSegments; row += 1) {
      const progress = row / this.heightSegments;
      this.luffGuides.push({
        particle: this.particleAt(0, row),
        x: Math.sin(Math.PI * progress) * luffArcDepth,
        y: -row * this.restY,
        z: this.particleAt(0, row).original.z,
      });
    }
    const attachmentDiagonal = Math.hypot(this.restX, this.restY);
    this.attachmentConstraints.push(
      new AttachmentConstraint(this.particleAt(0, 0), this.particleAt(1, 0), this.restX),
      new AttachmentConstraint(this.particleAt(0, 0), this.particleAt(1, 1), attachmentDiagonal),
      new AttachmentConstraint(this.particleAt(0, 0), this.particleAt(2, 0), this.restX * 2),
      new AttachmentConstraint(this.particleAt(0, this.heightSegments), this.particleAt(1, this.heightSegments), this.restX),
      new AttachmentConstraint(this.particleAt(0, this.heightSegments), this.particleAt(1, this.heightSegments - 1), attachmentDiagonal),
      new AttachmentConstraint(this.particleAt(0, this.heightSegments), this.particleAt(2, this.heightSegments), this.restX * 2)
    );

    for (let row = 0; row < this.heightSegments; row += 1) {
      for (let column = 0; column < this.widthSegments; column += 1) {
        const topLeft = this.indexAt(column, row);
        const topRight = this.indexAt(column + 1, row);
        const bottomLeft = this.indexAt(column, row + 1);
        const bottomRight = this.indexAt(column + 1, row + 1);
        this.indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
      }
    }

    for (let row = 0; row <= this.heightSegments; row += 1) {
      for (let column = 0; column <= this.widthSegments; column += 1) {
        if (column < this.widthSegments) {
          this.constraints.push(new Constraint(this.particleAt(column, row), this.particleAt(column + 1, row), this.restX));
          this.lengthConstraints.push(new FixedConstraint(this.particleAt(column, row), this.particleAt(column + 1, row), this.restX));
        }
        if (row < this.heightSegments) this.constraints.push(new Constraint(this.particleAt(column, row), this.particleAt(column, row + 1), this.restY));
        if (column < this.widthSegments && row < this.heightSegments) {
          const diagonal = Math.hypot(this.restX, this.restY);
          this.constraints.push(new Constraint(this.particleAt(column, row), this.particleAt(column + 1, row + 1), diagonal));
          this.constraints.push(new Constraint(this.particleAt(column + 1, row), this.particleAt(column, row + 1), diagonal));
        }
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3).setUsage(THREE.StreamDrawUsage));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    this.geometry.setIndex(this.indices);
    this.geometry.computeVertexNormals();
  }

  setSelfCollisionOptions(options: SelfCollisionOptions): void {
    this.selfCollisionOptions = this.normalizeSelfCollisionOptions(options);
  }

  /** Calm residual momentum while the flag is below its configured wind pickup height. */
  dampenMotion(retainedVelocity = 0.12): void {
    const retained = THREE.MathUtils.clamp(retainedVelocity, 0, 1);
    for (const particle of this.particles) {
      if (this.pinnedParticles.has(particle)) continue;
      particle.previous.lerp(particle.position, 1 - retained);
    }
  }

  reset(): void {
    for (const particle of this.particles) particle.reset();
    this.render();
  }

  snapshot(): ClothSnapshot {
    const positions: number[] = [];
    const previous: number[] = [];
    for (const particle of this.particles) {
      positions.push(particle.position.x, particle.position.y, particle.position.z);
      previous.push(particle.previous.x, particle.previous.y, particle.previous.z);
    }
    return { width: this.width, height: this.height, widthSegments: this.widthSegments, heightSegments: this.heightSegments, positions, previous };
  }

  /** Restore an old simulation, resampling its grid when resolution changed. */
  restore(snapshot: ClothSnapshot): void {
    const oldStride = snapshot.widthSegments + 1;
    const read = (values: number[], column: number, row: number): THREE.Vector3 => {
      const u = this.widthSegments ? column / this.widthSegments : 0;
      const v = this.heightSegments ? row / this.heightSegments : 0;
      const oldColumn = Math.min(snapshot.widthSegments, Math.round(u * snapshot.widthSegments));
      const oldRow = Math.min(snapshot.heightSegments, Math.round(v * snapshot.heightSegments));
      const offset = (oldColumn + oldRow * oldStride) * 3;
      return new THREE.Vector3(values[offset] ?? 0, values[offset + 1] ?? 0, values[offset + 2] ?? 0);
    };
    for (let row = 0; row <= this.heightSegments; row += 1) {
      for (let column = 0; column <= this.widthSegments; column += 1) {
        const particle = this.particleAt(column, row);
        particle.position.copy(read(snapshot.positions, column, row));
        particle.previous.copy(read(snapshot.previous, column, row));
        const scaleX = snapshot.width > 0 ? this.width / snapshot.width : 1;
        const scaleY = snapshot.height > 0 ? this.height / snapshot.height : 1;
        particle.position.x *= scaleX; particle.previous.x *= scaleX;
        particle.position.y *= scaleY; particle.previous.y *= scaleY;
        if (column === 0) {
          // The mast attachment follows the new rest pose while retaining any
          // motion in the rest of the cloth.
          particle.position.x = particle.original.x;
          particle.previous.x = particle.original.x;
        }
      }
    }
    this.render();
  }

  simulate(wind: WindParameters): void {
    const gust = 1 + wind.gustiness * (
      0.42 * Math.sin(wind.time * 0.9 + wind.phase)
      + 0.2 * Math.sin(wind.time * 2.7 + wind.phase * 1.9)
    );
    const windSpeed = Math.max(0, wind.strength * MAX_WIND_SPEED * gust);
    const directionRadians = THREE.MathUtils.degToRad(wind.direction);
    const windDirection = this.windPressure.set(
      Math.sin(directionRadians) + wind.turbulence * 0.12 * Math.sin(wind.time * 1.7 + wind.phase),
      wind.turbulence * 0.07 * Math.sin(wind.time * 1.3 + wind.phase * 1.4),
      Math.cos(directionRadians)
    ).normalize();
    windDirection.multiplyScalar(0.5 * AIR_DENSITY * windSpeed * windSpeed);
    this.gravity.set(0, -GRAVITY * SURFACE_MASS * this.width * this.height / this.particles.length, 0);

    for (const particle of this.particles) {
      // Gravity remains active throughout the hoist. This is what lets the
      // unfurled cloth hang naturally before the wind envelope reaches it.
      particle.applyForce(this.gravity);
    }
    this.applyUnfurlForce(wind.unfurl);
    this.applyWindForce(windDirection);
    for (const particle of this.particles) particle.integrate();

    for (let iteration = 0; iteration < ITERATION_COUNT; iteration += 1) {
      for (const constraint of this.constraints) constraint.resolve();
      for (const constraint of this.lengthConstraints) constraint.resolve();
      for (const particle of this.pins) {
        particle.position.copy(particle.original);
        particle.previous.copy(particle.original);
      }
      for (const constraint of this.attachmentConstraints) constraint.resolve();
      for (const guide of this.luffGuides) {
        guide.particle.position.x = THREE.MathUtils.lerp(guide.particle.position.x, guide.x, 0.94);
        guide.particle.position.y = THREE.MathUtils.lerp(guide.particle.position.y, guide.y, 0.94);
        guide.particle.position.z = THREE.MathUtils.lerp(guide.particle.position.z, guide.z, 0.9);
      }
    }
    if (this.selfCollisionOptions.selfCollision) this.resolveSelfCollisions();
    this.render();
  }

  private resolveSelfCollisions(): void {
    const { collisionThickness, collisionIterations } = this.selfCollisionOptions;
    const cellSize = collisionThickness;

    for (let iteration = 0; iteration < collisionIterations; iteration += 1) {
      this.clearCollisionHash();
      for (let index = 0; index < this.particles.length; index += 1) {
        const particle = this.particles[index];
        if (!this.hasFinitePosition(particle.position)) continue;
        const cellX = Math.floor(particle.position.x / cellSize);
        const cellY = Math.floor(particle.position.y / cellSize);
        const cellZ = Math.floor(particle.position.z / cellSize);
        const key = `${cellX},${cellY},${cellZ}`;
        let bucket = this.collisionHash.get(key);
        if (!bucket) {
          bucket = this.collisionBucketPool.pop() ?? [];
          this.collisionHash.set(key, bucket);
        }
        bucket.push(index);
      }

      for (let index = 0; index < this.particles.length; index += 1) {
        const particle = this.particles[index];
        if (!this.hasFinitePosition(particle.position)) continue;
        const cellX = Math.floor(particle.position.x / cellSize);
        const cellY = Math.floor(particle.position.y / cellSize);
        const cellZ = Math.floor(particle.position.z / cellSize);

        for (let z = cellZ - 1; z <= cellZ + 1; z += 1) {
          for (let y = cellY - 1; y <= cellY + 1; y += 1) {
            for (let x = cellX - 1; x <= cellX + 1; x += 1) {
              const bucket = this.collisionHash.get(`${x},${y},${z}`);
              if (!bucket) continue;
              for (const otherIndex of bucket) {
                if (otherIndex <= index || this.isDirectMeshNeighbor(index, otherIndex)) continue;
                this.resolveParticlePair(index, otherIndex, collisionThickness);
              }
            }
          }
        }
      }
    }
    this.clearCollisionHash();
  }

  private resolveParticlePair(firstIndex: number, secondIndex: number, thickness: number): void {
    const first = this.particles[firstIndex];
    const second = this.particles[secondIndex];
    if (!this.hasFinitePosition(first.position) || !this.hasFinitePosition(second.position)) return;

    this.edgeA.subVectors(second.position, first.position);
    const distanceSquared = this.edgeA.lengthSq();
    if (!Number.isFinite(distanceSquared) || distanceSquared >= thickness * thickness) return;

    const firstPinned = this.pinnedParticles.has(first);
    const secondPinned = this.pinnedParticles.has(second);
    if (firstPinned && secondPinned) return;

    let distance = Math.sqrt(distanceSquared);
    if (!Number.isFinite(distance) || distance < 1e-6) {
      // Coincident particles have no usable separation vector. A stable,
      // deterministic fallback avoids NaNs and keeps the correction bounded.
      const firstColumn = firstIndex % (this.widthSegments + 1);
      const firstRow = Math.floor(firstIndex / (this.widthSegments + 1));
      const secondColumn = secondIndex % (this.widthSegments + 1);
      const secondRow = Math.floor(secondIndex / (this.widthSegments + 1));
      this.edgeA.set(
        secondColumn >= firstColumn ? 1 : -1,
        secondRow >= firstRow ? 0.25 : -0.25,
        ((firstIndex + secondIndex) & 1) === 0 ? 0.1 : -0.1
      ).normalize();
      distance = 0;
    } else {
      this.edgeA.multiplyScalar(1 / distance);
    }

    const overlap = Math.min(thickness - distance, thickness);
    if (!Number.isFinite(overlap) || overlap <= 0) return;

    if (firstPinned) {
      this.applyCollisionCorrection(second, this.edgeA, overlap);
    } else if (secondPinned) {
      this.applyCollisionCorrection(first, this.edgeA, -overlap);
    } else {
      this.applyCollisionCorrection(first, this.edgeA, -overlap * 0.5);
      this.applyCollisionCorrection(second, this.edgeA, overlap * 0.5);
    }
  }

  private applyCollisionCorrection(particle: Particle, direction: THREE.Vector3, amount: number): void {
    const correction = this.collisionCorrection.copy(direction).multiplyScalar(amount);
    if (!this.hasFinitePosition(correction)) return;

    particle.position.add(correction);
    // Move the previous position by the same amount. This preserves the
    // Verlet velocity instead of turning positional separation into a burst.
    if (this.hasFinitePosition(particle.previous)) particle.previous.add(correction);
    else particle.previous.copy(particle.position);
    if (!this.hasFinitePosition(particle.position)) {
      particle.position.copy(particle.previous);
    }
  }

  private clearCollisionHash(): void {
    for (const bucket of this.collisionHash.values()) {
      bucket.length = 0;
      this.collisionBucketPool.push(bucket);
    }
    this.collisionHash.clear();
  }

  private isDirectMeshNeighbor(firstIndex: number, secondIndex: number): boolean {
    const stride = this.widthSegments + 1;
    const firstColumn = firstIndex % stride;
    const firstRow = Math.floor(firstIndex / stride);
    const secondColumn = secondIndex % stride;
    const secondRow = Math.floor(secondIndex / stride);
    return Math.abs(firstColumn - secondColumn) <= 1 && Math.abs(firstRow - secondRow) <= 1;
  }

  private hasFinitePosition(position: THREE.Vector3): boolean {
    return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
  }

  private normalizeSelfCollisionOptions(options: SelfCollisionOptions): SelfCollisionOptions {
    const normalizedOptions = options ?? DEFAULT_SELF_COLLISION_OPTIONS;
    const thickness = Number.isFinite(normalizedOptions.collisionThickness)
      ? THREE.MathUtils.clamp(normalizedOptions.collisionThickness, 0.01, 0.2)
      : DEFAULT_SELF_COLLISION_OPTIONS.collisionThickness;
    return {
      selfCollision: normalizedOptions.selfCollision === true,
      collisionThickness: thickness,
      collisionIterations: normalizedOptions.collisionIterations === 2 ? 2 : 1,
    };
  }

  private applyUnfurlForce(amount: number): void {
    if (amount <= 0) return;
    // A bounded outward tension is integrated like any other force. It is
    // strongest at the free edge and cannot move the pinned mast column.
    const maximumForce = 0.34 * Math.min(1, amount);
    const stride = this.widthSegments + 1;
    for (let index = 0; index < this.particles.length; index += 1) {
      const column = index % stride;
      if (column === 0) continue;
      const targetX = column * this.restX;
      const restoringForce = (targetX - this.particles[index].position.x) * 0.8 * Math.min(1, amount);
      this.unfurlForce.set(THREE.MathUtils.clamp(restoringForce, -maximumForce, maximumForce), 0, 0);
      this.particles[index].applyForce(this.unfurlForce);
    }
  }

  private applyWindForce(force: THREE.Vector3): void {
    const forceScale = DRAG_COEFFICIENT * this.faceArea / 3;
    for (let offset = 0; offset < this.indices.length; offset += 3) {
      const first = this.particles[this.indices[offset]];
      const second = this.particles[this.indices[offset + 1]];
      const third = this.particles[this.indices[offset + 2]];
      this.edgeA.subVectors(third.position, second.position);
      this.edgeB.subVectors(first.position, second.position);
      this.faceNormal.crossVectors(this.edgeA, this.edgeB).normalize();
      const pressure = this.faceNormal.dot(force) * forceScale;
      const projected = this.faceNormal.multiplyScalar(pressure);
      first.applyForce(projected);
      second.applyForce(projected);
      third.applyForce(projected);
    }
  }

  private render(): void {
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index].position;
      position.setXYZ(index, particle.x, particle.y, particle.z);
    }
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  private indexAt(column: number, row: number): number {
    return column + row * (this.widthSegments + 1);
  }

  private particleAt(column: number, row: number): Particle {
    return this.particles[this.indexAt(column, row)];
  }
}

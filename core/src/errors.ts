// Typed errors for the OPW engine.

/** A workflow failed validation with one or more errors. */
export class ValidationError extends Error {
  constructor(
    message: string,
    /** The offending diagnostic codes, for programmatic handling. */
    readonly codes: string[] = [],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** An op needed a capability no available adapter could satisfy. */
export class UnsatisfiedCapabilityError extends Error {
  constructor(
    message: string,
    readonly capability: string,
  ) {
    super(message);
    this.name = "UnsatisfiedCapabilityError";
  }
}

/** A referenced input / asset was missing on disk. */
export class MissingFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "MissingFileError";
  }
}

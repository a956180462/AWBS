export class AwbsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwbsError";
  }
}

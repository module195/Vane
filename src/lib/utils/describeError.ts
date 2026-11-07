/* Only the kind of error is logged: its message can echo the model output,
   which may quote the user's question. */
export const describeError = (err: unknown) => {
  const status = (err as { status?: unknown })?.status;
  const name = err instanceof Error ? err.name : typeof err;
  return status ? `${name} (status ${status})` : name;
};

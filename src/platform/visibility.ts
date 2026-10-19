// What a viewer may see, by producer code (document section 13).
// 'all' is head office. Otherwise the viewer holds a list of producer codes and sees only records under them.
// In step C3 this list will be worked out from the signed-in user; for now the caller passes it in.
export type Visibility = 'all' | { readonly producerCodes: readonly string[] };

export const canSeeProducerCode = (visibility: Visibility, producerCode: string): boolean =>
  visibility === 'all' || visibility.producerCodes.includes(producerCode);

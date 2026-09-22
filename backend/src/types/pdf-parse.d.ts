/** Type declaration for the untyped pdf-parse package. */
declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string
    numpages: number
    numrender: number
    info: unknown
    metadata: unknown
    version: string
  }
  function pdfParse(buffer: Buffer): Promise<PdfParseResult>
  export default pdfParse
}

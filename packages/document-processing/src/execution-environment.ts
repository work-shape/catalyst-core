export interface DocumentExecutionEnvironment {
  commands: {
    python: string;
    pdfInfo: string;
    pdfRenderer: string;
    officeConverter: string;
    generalConverter: string;
  };
  generalConverterArgs: readonly string[];
}

export function createDefaultDocumentExecutionEnvironment(): DocumentExecutionEnvironment {
  return {
    commands: {
      python: "python3",
      pdfInfo: "pdfinfo",
      pdfRenderer: "pdftoppm",
      officeConverter: "soffice",
      generalConverter: "markitdown"
    },
    generalConverterArgs: []
  };
}

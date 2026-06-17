export interface DocumentExecutionEnvironment {
  commands: {
    python: string;
    pdfInfo: string;
    pdfRenderer: string;
    officeConverter: string;
  };
}

export function createDefaultDocumentExecutionEnvironment(): DocumentExecutionEnvironment {
  return {
    commands: {
      python: "python3",
      pdfInfo: "pdfinfo",
      pdfRenderer: "pdftoppm",
      officeConverter: "soffice"
    }
  };
}

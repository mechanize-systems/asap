declare module "vm" {
  interface SourceTextModuleOptions {
    url?: string;
    context?: Context;
    lineOffset?: number;
    columnOffset?: number;
    initializeImportMeta?(meta: ImportMeta, module: SourceTextModule): void;
    importModuleDynamically?(
      specifier: string,
      module: SourceTextModule
    ): Object | SourceTextModule;
  }

  interface SourceTextModuleEvaluateOptions {
    timeout?: number;
    breakOnSigint?: boolean;
  }

  type SourceTextModuleStatus =
    | "uninstantiated"
    | "instantiating"
    | "instantiated"
    | "evaluating"
    | "evaluated"
    | "errored";
  type SourceTextModuleLinkingStatus =
    | "unlinked"
    | "linking"
    | "linked"
    | "errored";

  class SourceTextModule {
    dependencySpecifiers: string[];
    error: any;
    linkingStatus: SourceTextModuleLinkingStatus;
    namespace: Object;
    status: SourceTextModuleStatus;
    url: string;
    constructor(code: string, options?: SourceTextModuleOptions);
    evaluate(options?: SourceTextModuleEvaluateOptions): Promise<any>;
    instantiate(): void;
    link(
      linker: (
        specifier: string,
        referencingModule: SourceTextModule
      ) => SourceTextModule | Promise<any>
    ): Promise<any>;
  }
}

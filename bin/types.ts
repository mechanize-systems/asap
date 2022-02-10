export type AppConfig = {
  /**
   * Project root.
   */
  projectRoot: string;

  /**
   * What mode application is running in.
   */
  mode?: "development" | "production";

  /**
   * Base path application is mounted to.
   *
   * Can be also specified through ASAP__BASEPATH environment variable.
   * Can be also specified dynamically via Content-Base HTTP header.
   */
  basePath?: string;

  /**
   * Page routes.
   *
   * This is mounted directly under $basePath/.
   */
} & ServeConfig;

export type ServeConfig = {
  /**
   * Interface to listen to.
   *
   * Can be also specified through ASAP__IFACE environment variable.
   */
  iface?: string | undefined;

  /**
   * Port to listen to.
   *
   * Can be also specified through ASAP__PORT environment variable.
   */
  port?: number | undefined;
};

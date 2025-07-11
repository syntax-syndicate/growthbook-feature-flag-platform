import { Response } from "express";
import cloneDeep from "lodash/cloneDeep";
import * as bq from "@google-cloud/bigquery";
import uniqid from "uniqid";
import { AuthRequest } from "back-end/src/types/AuthRequest";
import { getContextFromReq } from "back-end/src/services/organizations";
import {
  DataSourceParams,
  DataSourceType,
  DataSourceSettings,
  DataSourceInterface,
  ExposureQuery,
  DataSourceInterfaceWithParams,
  GrowthbookClickhouseDataSource,
  MaterializedColumn,
} from "back-end/types/datasource";
import {
  getSourceIntegrationObject,
  getNonSensitiveParams,
  mergeParams,
  encryptParams,
  testQuery,
  getIntegrationFromDatasourceId,
  runFreeFormQuery,
} from "back-end/src/services/datasource";
import { getOauth2Client } from "back-end/src/integrations/GoogleAnalytics";
import {
  getQueriesByDatasource,
  getQueriesByIds,
} from "back-end/src/models/QueryModel";
import { findDimensionsByDataSource } from "back-end/src/models/DimensionModel";
import {
  createDataSource,
  getDataSourcesByOrganization,
  getDataSourceById,
  deleteDatasource,
  updateDataSource,
} from "back-end/src/models/DataSourceModel";
import { GoogleAnalyticsParams } from "back-end/types/integrations/googleanalytics";
import { getMetricsByDatasource } from "back-end/src/models/MetricModel";
import { deleteInformationSchemaById } from "back-end/src/models/InformationSchemaModel";
import { deleteInformationSchemaTablesByInformationSchemaId } from "back-end/src/models/InformationSchemaTablesModel";
import { queueCreateAutoGeneratedMetrics } from "back-end/src/jobs/createAutoGeneratedMetrics";
import { TemplateVariables } from "back-end/types/sql";
import { getUserById } from "back-end/src/models/UserModel";
import { AuditUserLoggedIn } from "back-end/types/audit";
import {
  createDimensionSlices,
  getLatestDimensionSlices,
  getDimensionSlicesById,
} from "back-end/src/models/DimensionSlicesModel";
import { DimensionSlicesQueryRunner } from "back-end/src/queryRunners/DimensionSlicesQueryRunner";
import {
  AutoMetricToCreate,
  SourceIntegrationInterface,
} from "back-end/src/types/Integration";
import {
  createClickhouseUser,
  getReservedColumnNames,
  updateMaterializedColumns,
} from "back-end/src/services/clickhouse";
import { FactTableColumnType } from "back-end/types/fact-table";
import { factTableColumnTypes } from "back-end/src/routers/fact-table/fact-table.validators";
import {
  getFactTablesForDatasource,
  updateFactTable,
} from "back-end/src/models/FactTableModel";
import { runRefreshColumnsQuery } from "back-end/src/jobs/refreshFactTableColumns";

export async function deleteDataSource(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { org } = context;
  const { id } = req.params;

  const datasource = await getDataSourceById(context, id);
  if (!datasource) {
    throw new Error("Cannot find datasource");
  }

  if (!context.permissions.canDeleteDataSource(datasource)) {
    context.permissions.throwPermissionError();
  }

  // Make sure this data source isn't the organizations default
  if (org.settings?.defaultDataSource === datasource.id) {
    throw new Error(
      "Error: This is the default data source for your organization. You must select a new default data source in your Organization Settings before deleting this one."
    );
  }

  // Make sure there are no metrics
  const metrics = await getMetricsByDatasource(context, datasource.id);
  if (metrics.length > 0) {
    throw new Error(
      "Error: Please delete all metrics tied to this datasource first."
    );
  }

  // Make sure there are no segments
  const segments = await context.models.segments.getByDataSource(datasource.id);

  if (segments.length > 0) {
    throw new Error(
      "Error: Please delete all segments tied to this datasource first."
    );
  }

  // Make sure there are no dimensions
  const dimensions = await findDimensionsByDataSource(
    datasource.id,
    datasource.organization
  );
  if (dimensions.length > 0) {
    throw new Error(
      "Error: Please delete all dimensions tied to this datasource first."
    );
  }

  await deleteDatasource(datasource, org.id);

  if (datasource.settings?.informationSchemaId) {
    const informationSchemaId = datasource.settings.informationSchemaId;

    await deleteInformationSchemaById(org.id, informationSchemaId);

    await deleteInformationSchemaTablesByInformationSchemaId(
      org.id,
      informationSchemaId
    );
  }

  res.status(200).json({
    status: 200,
  });
}

export async function getDataSources(req: AuthRequest, res: Response) {
  const context = getContextFromReq(req);
  const datasources = await getDataSourcesByOrganization(context);

  if (!datasources || !datasources.length) {
    res.status(200).json({
      status: 200,
      datasources: [],
    });
    return;
  }

  res.status(200).json({
    status: 200,
    datasources: datasources.map((d) => {
      const integration = getSourceIntegrationObject(context, d);
      return {
        id: d.id,
        name: d.name,
        description: d.description,
        type: d.type,
        settings: d.settings,
        projects: d.projects ?? [],
        params: getNonSensitiveParams(integration),
      };
    }),
  });
}

export async function getDataSource(
  req: AuthRequest<null, { id: string }>,
  res: Response<DataSourceInterfaceWithParams>
) {
  const context = getContextFromReq(req);
  const { id } = req.params;

  const integration = await getIntegrationFromDatasourceId(context, id);

  res.status(200).json(getDataSourceWithParams(integration));
}

function getDataSourceWithParams(
  integration: SourceIntegrationInterface
): DataSourceInterfaceWithParams {
  const datasource = integration.datasource;

  // eslint-disable-next-line
  const { params, ...otherFields } = datasource;

  return {
    ...otherFields,
    params: getNonSensitiveParams(integration),
    decryptionError: integration.decryptionError,
  };
}

export async function postDataSources(
  req: AuthRequest<{
    name: string;
    description?: string;
    type: DataSourceType;
    params: DataSourceParams;
    settings: DataSourceSettings;
    projects?: string[];
  }>,
  res: Response<
    | {
        status: 200;
        id: string;
        datasource: DataSourceInterfaceWithParams;
      }
    | {
        status: 400;
        message: string;
      }
  >
) {
  const context = getContextFromReq(req);
  const { name, description, type, params, projects } = req.body;
  const settings = req.body.settings || {};

  if (!context.permissions.canCreateDataSource({ projects, type })) {
    context.permissions.throwPermissionError();
  }

  try {
    // Set default event properties and queries
    settings.events = {
      experimentEvent: "$experiment_started",
      experimentIdProperty: "Experiment name",
      variationIdProperty: "Variant name",
      ...settings?.events,
    };

    const datasource = await createDataSource(
      context,
      name,
      type,
      params,
      settings,
      undefined,
      description,
      projects
    );

    const integration = getSourceIntegrationObject(context, datasource);

    res.status(200).json({
      status: 200,
      id: datasource.id,
      datasource: getDataSourceWithParams(integration),
    });
  } catch (e) {
    res.status(400).json({
      status: 400,
      message: e.message || "An error occurred",
    });
  }
}

export async function postInbuiltDataSource(
  req: AuthRequest<
    {
      name?: string;
      description?: string;
      type?: DataSourceType;
      params?: DataSourceParams;
      settings?: DataSourceSettings;
      projects?: string[];
    },
    { id: string }
  >,
  res: Response<
    | {
        status: 200;
        datasource: DataSourceInterface;
      }
    | {
        status: 400 | 403 | 404;
        message: string;
      }
  >
) {
  if (!req.superAdmin) {
    return res.status(403).json({
      status: 403,
      message: "Only super admins can add a datasource for now.",
    });
  }

  const context = getContextFromReq(req);
  const new_datasource_id = req.params.id || uniqid("ds_");
  const params = await createClickhouseUser(context, new_datasource_id);
  const datasourceSettings: DataSourceSettings = {
    userIdTypes: [
      {
        userIdType: "device_id",
      },
      {
        userIdType: "user_id",
      },
    ],
    queries: {
      exposure: [
        {
          id: "device_id",
          dimensions: [
            "country",
            "browser",
            "os",
            "device_type",
            "source",
            "medium",
            "campaign",
          ],
          name: "Device Id Experiments",
          query: `         
SELECT 
  device_id,
  timestamp,
  simpleJSONExtractString(properties_json, 'experimentId') as experiment_id,
  simpleJSONExtractString(properties_json, 'variationId') as variation_id,
  geo_country as country,
  ua_browser as browser,
  ua_os as os,
  ua_device_type as device_type,
  utm_source as source,
  utm_medium as medium,
  utm_campaign as campaign
FROM events
WHERE
  event_name = 'Experiment Viewed'
  AND timestamp BETWEEN '{{startDate}}' AND '{{endDate}}'
              `.trim(),
          userIdType: "device_id",
        },
        {
          id: "user_id",
          dimensions: [
            "country",
            "browser",
            "os",
            "device_type",
            "source",
            "medium",
            "campaign",
          ],
          name: "Logged in User Id Experiments",
          query: `         
SELECT 
  user_id,
  timestamp,
  simpleJSONExtractString(properties_json, 'experimentId') as experiment_id,
  simpleJSONExtractString(properties_json, 'variationId') as variation_id,
  geo_country as country,
  ua_browser as browser,
  ua_os as os,
  ua_device_type as device_type,
  utm_source as source,
  utm_medium as medium,
  utm_campaign as campaign
FROM events
WHERE
  event_name = 'Experiment Viewed'
  AND timestamp BETWEEN '{{startDate}}' AND '{{endDate}}'
              `.trim(),
          userIdType: "user_id",
        },
      ],
    },
  };

  const newDatasource = await createDataSource(
    context,
    "Growthbook ClickHouse",
    "growthbook_clickhouse",
    params,
    datasourceSettings,
    new_datasource_id
  );
  res.status(200).json({
    status: 200,
    datasource: newDatasource,
  });
}

export async function putDataSource(
  req: AuthRequest<
    {
      name?: string;
      description?: string;
      type?: DataSourceType;
      params?: DataSourceParams;
      settings?: DataSourceSettings;
      projects?: string[];
      metricsToCreate?: AutoMetricToCreate[];
    },
    { id: string }
  >,
  res: Response<
    | {
        status: 200;
        datasource: DataSourceInterfaceWithParams;
      }
    | {
        status: 400 | 403 | 404;
        message: string;
      }
  >
) {
  const userId = req.userId;

  if (!userId) {
    res.status(403).json({
      status: 403,
      message: "User not found",
    });
    return;
  }

  const user = await getUserById(userId);

  if (!user) {
    res.status(403).json({
      status: 403,
      message: "User not found",
    });
    return;
  }

  const userObj: AuditUserLoggedIn = {
    id: user.id,
    email: user.email,
    name: user.name || "",
  };
  const context = getContextFromReq(req);
  const { org } = context;
  const { id } = req.params;
  const {
    name,
    description,
    type,
    params,
    settings,
    projects,
    metricsToCreate,
  } = req.body;

  const datasource = await getDataSourceById(context, id);
  if (!datasource) {
    res.status(404).json({
      status: 404,
      message: "Cannot find data source",
    });
    return;
  }

  if (!context.permissions.canUpdateDataSourceSettings(datasource)) {
    context.permissions.throwPermissionError();
  }

  // Require higher permissions to change connection settings vs updating query settings
  if (params) {
    if (!context.permissions.canUpdateDataSourceParams(datasource)) {
      context.permissions.throwPermissionError();
    }
  }

  // If changing projects, make sure the user has access to the new projects as well
  if (projects) {
    if (!context.permissions.canUpdateDataSourceSettings({ projects })) {
      context.permissions.throwPermissionError();
    }
  }

  if (type && type !== datasource.type) {
    res.status(400).json({
      status: 400,
      message:
        "Cannot change the type of an existing data source. Create a new one instead.",
    });
    return;
  }

  if (metricsToCreate?.length) {
    await queueCreateAutoGeneratedMetrics(
      datasource.id,
      org.id,
      metricsToCreate,
      userObj
    );
  }

  try {
    const updates: Partial<DataSourceInterface> = { dateUpdated: new Date() };

    if (name) {
      updates.name = name;
    }

    if ("description" in req.body) {
      updates.description = description;
    }

    if (settings) {
      updates.settings = settings;
    }

    if (projects) {
      updates.projects = projects;
    }

    if (
      type === "google_analytics" &&
      params &&
      (params as GoogleAnalyticsParams).refreshToken
    ) {
      const oauth2Client = getOauth2Client();
      const { tokens } = await oauth2Client.getToken(
        (params as GoogleAnalyticsParams).refreshToken
      );
      (params as GoogleAnalyticsParams).refreshToken =
        tokens.refresh_token || "";
    }

    // If the connection params changed, re-validate the connection
    // If the user is just updating the display name, no need to do this
    if (params) {
      const integration = getSourceIntegrationObject(context, datasource);
      mergeParams(integration, params);
      await integration.testConnection();
      updates.params = encryptParams(integration.params);
    }

    await updateDataSource(context, datasource, updates);

    const integration = getSourceIntegrationObject(context, {
      ...datasource,
      ...updates,
    });

    res.status(200).json({
      status: 200,
      datasource: getDataSourceWithParams(integration),
    });
  } catch (e) {
    req.log.error(e, "Failed to update data source");
    res.status(400).json({
      status: 400,
      message: e.message || "An error occurred",
    });
  }
}

export async function updateExposureQuery(
  req: AuthRequest<
    {
      updates: Partial<ExposureQuery>;
    },
    { datasourceId: string; exposureQueryId: string }
  >,
  res: Response
) {
  const context = getContextFromReq(req);
  const { datasourceId, exposureQueryId } = req.params;
  const { updates } = req.body;

  const dataSource = await getDataSourceById(context, datasourceId);
  if (!dataSource) {
    res.status(404).json({
      status: 404,
      message: "Cannot find data source",
    });
    return;
  }

  if (!context.permissions.canUpdateDataSourceSettings(dataSource)) {
    context.permissions.throwPermissionError();
  }

  const copy = cloneDeep<DataSourceInterface>(dataSource);
  const exposureQueryIndex = copy.settings.queries?.exposure?.findIndex(
    (e) => e.id === exposureQueryId
  );
  if (
    exposureQueryIndex === undefined ||
    !copy.settings.queries?.exposure?.[exposureQueryIndex]
  ) {
    res.status(404).json({
      status: 404,
      message: "Cannot find exposure query",
    });
    return;
  }

  const exposureQuery = copy.settings.queries.exposure[exposureQueryIndex];
  copy.settings.queries.exposure[exposureQueryIndex] = {
    ...exposureQuery,
    ...updates,
  };

  try {
    const updates: Partial<DataSourceInterface> = {
      dateUpdated: new Date(),
      settings: copy.settings,
    };

    await updateDataSource(context, dataSource, updates);

    res.status(200).json({
      status: 200,
    });
  } catch (e) {
    req.log.error(e, "Failed to update exposure query");
    res.status(400).json({
      status: 400,
      message: e.message || "An error occurred",
    });
  }
}

export async function postGoogleOauthRedirect(
  req: AuthRequest<{ projects?: string[] }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { projects } = req.body;

  if (
    !context.permissions.canCreateDataSource({
      projects,
      type: "google_analytics",
    })
  ) {
    context.permissions.throwPermissionError();
  }

  const oauth2Client = getOauth2Client();

  const url = oauth2Client.generateAuthUrl({
    // eslint-disable-next-line
    access_type: "offline",
    // eslint-disable-next-line
    include_granted_scopes: true,
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/analytics.readonly",
  });

  res.status(200).json({
    status: 200,
    url,
  });
}

export async function getQueries(
  req: AuthRequest<null, { ids: string }>,
  res: Response
) {
  const { org } = getContextFromReq(req);
  const { ids } = req.params;
  const queries = ids.split(",");

  const docs = await getQueriesByIds(org.id, queries);

  // Lookup table so we can return queries in the same order we received them
  const map = new Map(docs.map((d) => [d.id, d]));

  res.status(200).json({
    queries: queries.map((id) => map.get(id) || null),
  });
}

export async function testLimitedQuery(
  req: AuthRequest<{
    query: string;
    datasourceId: string;
    templateVariables?: TemplateVariables;
  }>,
  res: Response
) {
  const context = getContextFromReq(req);

  const { query, datasourceId, templateVariables } = req.body;

  const datasource = await getDataSourceById(context, datasourceId);
  if (!datasource) {
    return res.status(404).json({
      status: 404,
      message: "Cannot find data source",
    });
  }

  const { results, sql, duration, error } = await testQuery(
    context,
    datasource,
    query,
    templateVariables
  );

  res.status(200).json({
    status: 200,
    duration,
    results,
    sql,
    error,
  });
}

export async function runQuery(
  req: AuthRequest<{
    query: string;
    datasourceId: string;
    limit?: number;
  }>,
  res: Response
) {
  const context = getContextFromReq(req);

  const { query, datasourceId, limit } = req.body;

  const datasource = await getDataSourceById(context, datasourceId);
  if (!datasource) {
    return res.status(404).json({
      status: 404,
      message: "Cannot find data source",
    });
  }

  const { results, sql, duration, error } = await runFreeFormQuery(
    context,
    datasource,
    query,
    limit
  );

  res.status(200).json({
    status: 200,
    duration,
    results,
    sql,
    error,
  });
}

export async function getDataSourceMetrics(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { id } = req.params;

  const metrics = await getMetricsByDatasource(context, id);

  res.status(200).json({
    status: 200,
    metrics,
  });
}

export async function getDataSourceQueries(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { id } = req.params;

  const datasourceObj = await getDataSourceById(context, id);
  if (!datasourceObj) {
    throw new Error("Could not find datasource");
  }

  req.checkPermissions(
    "readData",
    datasourceObj?.projects?.length ? datasourceObj.projects : []
  );

  const queries = await getQueriesByDatasource(context.org.id, id);

  res.status(200).json({
    status: 200,
    queries,
  });
}

export async function getDimensionSlices(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const { org } = getContextFromReq(req);
  const { id } = req.params;

  const dimensionSlices = await getDimensionSlicesById(org.id, id);

  res.status(200).json({
    status: 200,
    dimensionSlices,
  });
}

export async function getLatestDimensionSlicesForDatasource(
  req: AuthRequest<null, { datasourceId: string; exposureQueryId: string }>,
  res: Response
) {
  const { org } = getContextFromReq(req);
  const { datasourceId, exposureQueryId } = req.params;

  const dimensionSlices = await getLatestDimensionSlices(
    org.id,
    datasourceId,
    exposureQueryId
  );

  res.status(200).json({
    status: 200,
    dimensionSlices,
  });
}

export async function postDimensionSlices(
  req: AuthRequest<{
    dataSourceId: string;
    queryId: string;
    lookbackDays: number;
  }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { org } = context;
  const { dataSourceId, queryId, lookbackDays } = req.body;

  const integration = await getIntegrationFromDatasourceId(
    context,
    dataSourceId,
    true
  );

  const model = await createDimensionSlices({
    organization: org.id,
    dataSourceId,
    queryId,
  });

  const queryRunner = new DimensionSlicesQueryRunner(
    context,
    model,
    integration
  );
  const outputmodel = await queryRunner.startAnalysis({
    exposureQueryId: queryId,
    lookbackDays: Number(lookbackDays) ?? 30,
  });
  res.status(200).json({
    status: 200,
    dimensionSlices: outputmodel,
  });
}

export async function cancelDimensionSlices(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { org } = context;
  const { id } = req.params;
  const dimensionSlices = await getDimensionSlicesById(org.id, id);
  if (!dimensionSlices) {
    throw new Error("Could not cancel automatic dimension");
  }

  const integration = await getIntegrationFromDatasourceId(
    context,
    dimensionSlices.datasource,
    true
  );

  const queryRunner = new DimensionSlicesQueryRunner(
    context,
    dimensionSlices,
    integration
  );
  await queryRunner.cancelQueries();

  res.status(200).json({
    status: 200,
  });
}

export async function fetchBigQueryDatasets(
  req: AuthRequest<{
    projectId: string;
    client_email: string;
    private_key: string;
  }>,
  res: Response
) {
  const { projectId, client_email, private_key } = req.body;

  try {
    const client = new bq.BigQuery({
      projectId,
      credentials: { client_email, private_key },
    });

    const [datasets] = await client.getDatasets();

    res.status(200).json({
      status: 200,
      datasets: datasets.map((dataset) => dataset.id).filter(Boolean),
    });
  } catch (e) {
    throw new Error(e.message);
  }
}

export async function postMaterializedColumn(
  req: AuthRequest<
    { sourceField: string; columnName: string; datatype: FactTableColumnType },
    { datasourceId: string }
  >,
  res: Response
) {
  const context = getContextFromReq(req);
  const { datasourceId } = req.params;
  const newColumn = sanitizeMatColumnInput(req.body);

  const datasource = await getDataSourceById(context, datasourceId);
  if (!datasource) {
    throw new Error("Cannot find datasource");
  }

  if (!context.permissions.canUpdateDataSourceSettings(datasource)) {
    context.permissions.throwPermissionError();
  }

  if (datasource.type !== "growthbook_clickhouse") {
    throw new Error(
      "Can only create materialized columns for growthbook-clickhouse datasources"
    );
  }

  const originalColumns = datasource.settings.materializedColumns || [];
  const finalColumns = [...originalColumns, newColumn];
  const updates: Pick<GrowthbookClickhouseDataSource, "settings"> = {
    settings: {
      ...datasource.settings,
      materializedColumns: finalColumns,
    },
  };

  try {
    await updateMaterializedColumns({
      datasource,
      columnsToAdd: [newColumn],
      columnsToDelete: [],
      columnsToRename: [],
      finalColumns,
      originalColumns,
    });

    await updateDataSource(context, datasource, updates);

    const factTables = await getFactTablesForDatasource(context, datasource.id);
    for (const ft of factTables) {
      const columns = await runRefreshColumnsQuery(context, datasource, ft);
      await updateFactTable(context, ft, { columns });
    }

    const integration = getSourceIntegrationObject(context, {
      ...datasource,
      ...updates,
    });

    res.status(200).json({
      status: 200,
      datasource: getDataSourceWithParams(integration),
    });
  } catch (e) {
    req.log.error(e, "Failed to update data source");
    res.status(500).json({
      status: 500,
      message: e.message || "An error occurred",
    });
  }
}

export async function updateMaterializedColumn(
  req: AuthRequest<
    { sourceField: string; columnName: string; datatype: FactTableColumnType },
    { datasourceId: string; matColumnName: string }
  >,
  res: Response
) {
  const context = getContextFromReq(req);
  const { datasourceId, matColumnName } = req.params;
  const newColumn = sanitizeMatColumnInput(req.body);

  const datasource = await getDataSourceById(context, datasourceId);
  if (!datasource) {
    throw new Error("Cannot find datasource");
  }

  if (!context.permissions.canUpdateDataSourceSettings(datasource)) {
    context.permissions.throwPermissionError();
  }

  if (datasource.type !== "growthbook_clickhouse") {
    throw new Error(
      "Can only manage materialized columns for growthbook-clickhouse datasources"
    );
  }
  if (matColumnName === newColumn.columnName) {
    throw new Error(
      "Cannot modify a column while keeping the same name. Delete the column and create it again instead"
    );
  }

  const originalColumns = datasource.settings.materializedColumns || [];

  const originalIdx = originalColumns.findIndex(
    (col) => col.columnName === matColumnName
  );
  if (originalIdx === -1) {
    throw new Error(`Cannot find materialized column ${matColumnName}`);
  }
  const originalColumn = originalColumns[originalIdx];

  const finalColumns = [
    ...originalColumns.slice(0, originalIdx),
    newColumn,
    ...originalColumns.slice(originalIdx + 1),
  ];

  const updates: Pick<GrowthbookClickhouseDataSource, "settings"> = {
    settings: {
      ...datasource.settings,
      materializedColumns: finalColumns,
    },
  };

  try {
    if (
      originalColumn.datatype === newColumn.datatype &&
      originalColumn.sourceField === newColumn.sourceField
    ) {
      // Simple rename
      await updateMaterializedColumns({
        datasource,
        columnsToAdd: [],
        columnsToDelete: [],
        columnsToRename: [
          { from: originalColumn.columnName, to: newColumn.columnName },
        ],
        finalColumns,
        originalColumns,
      });
    } else {
      // Drop original column and recreate
      await updateMaterializedColumns({
        datasource,
        columnsToAdd: [newColumn],
        columnsToDelete: [originalColumn.columnName],
        columnsToRename: [],
        finalColumns,
        originalColumns,
      });
    }
    await updateDataSource(context, datasource, updates);

    const factTables = await getFactTablesForDatasource(context, datasource.id);
    for (const ft of factTables) {
      const columns = await runRefreshColumnsQuery(context, datasource, ft);
      await updateFactTable(context, ft, { columns });
    }

    const integration = getSourceIntegrationObject(context, {
      ...datasource,
      ...updates,
    });

    res.status(200).json({
      status: 200,
      datasource: getDataSourceWithParams(integration),
    });
  } catch (e) {
    req.log.error(e, "Failed to update data source");
    res.status(500).json({
      status: 500,
      message: e.message || "An error occurred",
    });
  }
}

export async function deleteMaterializedColumn(
  req: AuthRequest<null, { datasourceId: string; matColumnName: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { datasourceId, matColumnName } = req.params;

  const datasource = await getDataSourceById(context, datasourceId);
  if (!datasource) {
    throw new Error("Cannot find datasource");
  }

  if (!context.permissions.canUpdateDataSourceSettings(datasource)) {
    context.permissions.throwPermissionError();
  }

  if (datasource.type !== "growthbook_clickhouse") {
    throw new Error(
      "Can only manage materialized columns for growthbook-clickhouse datasources"
    );
  }

  const originalColumns = datasource.settings.materializedColumns || [];

  const originalIdx = originalColumns.findIndex(
    (col) => col.columnName === matColumnName
  );
  if (originalIdx === -1) {
    throw new Error(`Cannot find materialized column ${matColumnName}`);
  }
  const finalColumns = [
    ...originalColumns.slice(0, originalIdx),
    ...originalColumns.slice(originalIdx + 1),
  ];

  const updates: Pick<GrowthbookClickhouseDataSource, "settings"> = {
    settings: {
      ...datasource.settings,
      materializedColumns: finalColumns,
    },
  };

  try {
    await updateMaterializedColumns({
      datasource,
      columnsToAdd: [],
      columnsToDelete: [matColumnName],
      columnsToRename: [],
      finalColumns,
      originalColumns,
    });
    await updateDataSource(context, datasource, updates);

    const integration = getSourceIntegrationObject(context, {
      ...datasource,
      ...updates,
    });

    res.status(200).json({
      status: 200,
      datasource: getDataSourceWithParams(integration),
    });
  } catch (e) {
    req.log.error(e, "Failed to update data source");
    res.status(500).json({
      status: 500,
      message: e.message || "An error occurred",
    });
  }
}

function sanitizeMatColumnInput(userInput: MaterializedColumn) {
  if (!factTableColumnTypes.includes(userInput.datatype)) {
    throw new Error("Invalid datatype");
  }
  const sourceField = sanitizeMatColumnSourceField(userInput.sourceField);
  const columnName = sanitizeMatColumnName(userInput.columnName);
  return {
    datatype: userInput.datatype,
    sourceField,
    columnName,
  };
}

function sanitizeMatColumnSourceField(userInput: string) {
  // Invalid characters
  if (!/^[a-zA-Z0-9 _-]*$/.test(userInput)) {
    throw new Error(
      "Invalid input. Source field must only use alphanumeric characters, ' ', '_', or '-'"
    );
  }
  // Must have at least 1 alpha character
  if (!/[a-zA-Z]/.test(userInput)) {
    throw new Error(
      "Invalid input. Source field must contain at least one letter"
    );
  }
  // Must not have leading or trailing spaces
  if (userInput.startsWith(" ") || userInput.endsWith(" ")) {
    throw new Error(
      "Invalid input. Source field must not have leading or trailing spaces"
    );
  }

  return userInput;
}

function sanitizeMatColumnName(userInput: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(userInput)) {
    throw new Error(
      "Invalid input. Column names must start with a letter or underscore and only use alphanumeric characters or '_'"
    );
  }

  const cmp = userInput.toLowerCase();

  // Make sure the columns don't overwrite default ones we define
  const reservedCols = getReservedColumnNames();
  if (reservedCols.has(cmp)) {
    throw new Error(
      `Column name "${userInput}" is reserved and cannot be used`
    );
  }

  // Most of these technically work as column names in ClickHouse,
  // but they would be confusing when writing and viewing SQL
  const sqlKeywords = new Set([
    "select",
    "from",
    "where",
    "order",
    "having",
    "limit",
    "offset",
    "join",
    "on",
    "using",
    "as",
    "distinct",
    "union",
    "if",
    "then",
    "else",
    "end",
    "case",
    "when",
    "and",
    "or",
    "not",
    "true",
    "false",
    "null",
    "is",
    "in",
    "between",
    "exists",
    "like",
    "array",
    "tuple",
    "map",
    "cast",
    "inf",
    "infinity",
    "nan",
    "default",
    "current_date",
    "current_timestamp",
    "sysdate",
  ]);
  if (sqlKeywords.has(cmp)) {
    throw new Error(
      `Column name "${userInput}" is a SQL keyword and cannot be used`
    );
  }

  return userInput;
}

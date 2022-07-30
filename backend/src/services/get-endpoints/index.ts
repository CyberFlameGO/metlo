import { FindManyOptions, FindOptionsWhere } from "typeorm";
import { GetEndpointParams } from "../../types";
import { AppDataSource } from "../../data-source"
import { ApiEndpoint } from "../../../models";

export class GetEndpointsService {
  static async getEndpoints(getEndpointParams: GetEndpointParams): Promise<ApiEndpoint[]> {
    try {
      const apiEndpointRepository = AppDataSource.getRepository(ApiEndpoint);
      let whereConditions: FindOptionsWhere<ApiEndpoint> = {}
      let paginationParams: FindManyOptions<ApiEndpoint> = {}
      if (getEndpointParams?.environment) {
        whereConditions = {
          ...whereConditions,
          environment: getEndpointParams.environment
        }
      }
      if (getEndpointParams?.host) {
        whereConditions = {
          ...whereConditions,
          host: getEndpointParams.host
        }
      }
      if (getEndpointParams?.offset) {
        paginationParams = {
          ...paginationParams,
          skip: getEndpointParams.offset
        }
      }
      if (getEndpointParams?.limit) {
        paginationParams = {
          ...paginationParams,
          take: getEndpointParams.limit
        }
      }
      
      const endpoints = await apiEndpointRepository.find({ where: whereConditions, ...paginationParams })

      // TODO: Calculate risk score for endpoints and if risk score param present, only return those that meet

      return endpoints
    } catch (err) {
      console.error(`Error in Get Endpoints service: ${err}`)
    }
  }
}
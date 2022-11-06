import axios from "axios"
import { Summary, InstanceSettings } from "@common/types"
import { getAPIURL } from "~/constants"

export const getSummary = async (): Promise<Summary> => {
  try {
    console.log(`${getAPIURL()}/summary`)
    const resp = await axios.get<Summary>(`${getAPIURL()}/summary`)
    if (resp.status === 200 && resp.data) {
      return resp.data
    }
    return null
  } catch (err) {
    console.error(`Error fetching summary stats: ${err}`)
    return null
  }
}

export const getInstanceSettings = async (): Promise<InstanceSettings> => {
  try {
    const resp = await axios.get<InstanceSettings>(
      `${getAPIURL()}/instance-settings`,
    )
    return resp.data
  } catch (err) {
    console.error(`Error fetching instance settings: ${err}`)
    return null
  }
}

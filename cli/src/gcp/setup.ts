import AsyncRetry from "async-retry"
import { promisify } from "util"
import { exec } from "child_process"
import { v4 as uuidv4 } from "uuid"
import fs from "fs"
import { prompt } from "enquirer"
import { GCP_REGIONS_SUPPORTED, wait_for_global_operation, wait_for_regional_operation, wait_for_zonal_operation } from "./gcpUtils"
import { GCP_CONN } from "./gcp_apis"
import chalk from "chalk"

const promiseExec = promisify(exec)

const verifyAccountDetails = async () => {
    const gcp_regions = GCP_REGIONS_SUPPORTED.map(e => ({
        name: e,
    }))
    const resp = await prompt([
        {
            type: "input",
            name: "_projectName",
            message: "GCP Project Name",
        }, {
            type: "input",
            initial: "default",
            name: "_networkName",
            message: "GCP Network to mirror",
        }, {
            type: "select",
            name: "_zoneName",
            message: "Select your GCP zone",
            initial: 1,
            choices: gcp_regions,
        }, {
            type: "input",
            name: "_keyPath",
            message: "Path to GCP key file",
            validate: (path: string) => {
                if (fs.existsSync(path)) {
                    return true
                } else {
                    // @ts-ignore
                    let text = chalk.redBright(`GCP Key file not found at ${path}`)
                    return text
                }
            }
        }
    ])

    // @ts-ignore Destructuring is improperly done
    const { _projectName: project, _networkName: network, _zoneName: zone, _keyPath: keyFilePath } = resp;

    const key = (fs.readFileSync(keyFilePath)).toString("utf-8");

    let conn = new GCP_CONN(key, zone, project)
    await conn.test_connection()
    await conn.get_zone({ zone })
    return { project, network, zone, key }
}

const sourceSelection = async (conn: GCP_CONN) => {

    var source_private_ip, source_subnetwork_url, source_instance_url, sourceTag = null
    const sourceTypeResp = await prompt([
        {
            type: "select",
            name: "_sourceType",
            message: "Select your mirror source type",
            initial: 1,
            choices: ["INSTANCE", "SUBNET", "TAG"],
        }
    ])
    let sourceType = sourceTypeResp["_sourceType"]
    if (sourceType === "INSTANCE") {
        const instanceNameResp = await prompt([
            {
                type: "input",
                name: "_name",
                message: "Enter the mirror source instance name",
            }
        ])
        let resp = await conn.get_instance(instanceNameResp['_name'])
        source_private_ip = resp[0].networkInterfaces[0].networkIP
        source_subnetwork_url = resp[0].networkInterfaces[0].subnetwork
        source_instance_url = resp[0].selfLink
    } else if (sourceType === "SUBNET") {
        const subnetNameResp = await prompt([
            {
                type: "input",
                name: "_name",
                message: "Enter the mirror source subnet name",
            }
        ])
        let resp = await conn.get_subnet_information({
            subnetName: subnetNameResp['_name'],
        })
        source_private_ip = resp[0].ipCidrRange
        source_subnetwork_url = resp[0].selfLink
        source_instance_url = resp[0].selfLink
    } else if (sourceType === "TAG") {
        const tagNameResp = await prompt([
            {
                type: "input",
                name: "_name",
                message: "Enter the mirror source tag name",
            }
        ])
        let resp = await conn.list_instances()
        let tagName = tagNameResp["_name"]
        if (!resp[0].find(v => v.tags.items.includes(tagName))) {
            throw new Error(
                `No instances with tag ${tagName} found in specifiec zone`,
            )
        }
        sourceTag: tagNameResp["_name"]
        source_private_ip = "0.0.0.0/0" // Allow any since filtering is done on tags by gcp
        source_subnetwork_url = ""
        source_instance_url = ""
    }
    return {
        sourceType,
        sourcePrivateIP: source_private_ip,
        sourceSubnetworkURL: source_subnetwork_url,
        sourceInstanceURL: source_instance_url,
        sourceTag,
    }

}

const getDestinationSubnet = async (
    conn,
    network_url,
    id,
) => {
    let addressName = `metlo-address-temporary-${id}`

    let address_resp = await conn.create_new_internal_address({
        addressName: addressName,
        network: network_url,
        prefixLength: 24,
    })

    await wait_for_global_operation(address_resp[0].latestResponse.name, conn)

    let connectionReadyResp = await AsyncRetry(
        async (f, at) => {
            let resp = await conn.get_address_information({
                addressName: addressName,
            })
            if (resp[0].status === "RESERVED") {
                return resp
            } else {
                throw Error("Couldn't reserve address")
            }
        },
        { retries: 5 },
    )
    const ip_range = `${connectionReadyResp[0].address}/${connectionReadyResp[0].prefixLength}`

    let delete_resp = await conn.delete_new_address({
        addressName: addressName,
    })
    await wait_for_global_operation(delete_resp[0].latestResponse.name, conn)

    let destination_subnetwork = await conn.create_new_subnet({
        network: network_url,
        ipCidr: ip_range,
        name: `metlo-subnet-${id}`,
    })
    await wait_for_regional_operation(
        destination_subnetwork[0].latestResponse.name,
        conn,
    )
    return { ipRange: ip_range, destinationSubnetworkUrl: destination_subnetwork[0].latestResponse.targetLink }
}

const createFirewallRule = async (
    conn,
    network_url,
    ip_range,
    id
) => {
    const firewallName = `metlo-firewall-${id}`
    let resp = await conn.create_firewall_rule({
        firewallName,
        networkName: network_url,
        ipRange: ip_range,
    })
    return { firewallRuleUrl: resp[0].latestResponse.targetLink }
}

const createCloudRouter = async (
    conn,
    network_url,
    destination_subnetwork_url,
    id,
) => {
    let resp = await conn.list_routers()
    let useful_routers = resp[0].filter(v => {
        const usesfulNats = v.nats.filter(nat =>
            [
                "ALL_SUBNETWORKS_ALL_IP_RANGES",
                "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES",
            ].includes(nat.sourceSubnetworkIpRangesToNat),
        )
        return v.network === network_url && usesfulNats.length > 0
    })
    var router_url
    if (useful_routers.length > 0) {
        const useful_nats = useful_routers[0].nats.find(nat =>
            [
                "ALL_SUBNETWORKS_ALL_IP_RANGES",
                "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES",
            ].includes(nat.sourceSubnetworkIpRangesToNat),
        )
        if (useful_nats) {
            router_url = useful_routers[0].selfLink
        }
    }
    if (!router_url) {
        let new_router = await conn.create_router({
            routerName: `metlo-router-${id}`,
            networkURL: network_url,
            subnetURL: destination_subnetwork_url,
        })
        // @ts-ignore
        router_url = new_router[0].latestResponse.targetLink
    }
    return {
        routerURL: router_url
    }

}

const create_mig = async (
    conn: GCP_CONN,
    network_url: string,
    destination_subnetwork_url: string,
    source_image: string,
    id: string,
) => {

    // Check for machine type :
    const [types] = await conn.list_machine_types({ filters: [] })
    const machineTypeResp = await prompt([
        {
            type: "autocomplete",
            name: "_machineType",
            message: "Mirror Instance Type",
            choices: types.map((v) => ({
                name: v.name
            }))
        },
    ])

    const imageTemplateName = `metlo-image-template-${id}`
    let image_resp = await conn.create_image_template({
        machineType: machineTypeResp["_machineType"],
        sourceImage: source_image,
        network: network_url,
        subnet: destination_subnetwork_url,
        imageTemplateName: imageTemplateName,
    })
    let img_resp = await wait_for_global_operation(
        image_resp[0].latestResponse.name,
        conn,
    )

    const instanceGroupName = `metlo-mig-${id}`
    let instance_manager = await conn.create_instance_manager({
        templateURL: img_resp[0].targetLink,
        instanceName: instanceGroupName,
    })
    let resp = await wait_for_zonal_operation(
        instance_manager[0].latestResponse.name,
        conn,
    )

    const instance_name = `metlo-scaler-${id}`

    let instance = await conn.list_instance_for_group({
        managedGroupName: instanceGroupName,
    })

    return {
        // @ts-ignore
        imageTemplateUrl: image_resp[0].latestResponse.targetLink,
        // @ts-ignore
        instanceUrl: instance[0][0].instance,
        instanceGroupName,
    }
}

const createHealthCheck = async (
    conn: GCP_CONN,
    id: string,
) => {
    const health_check_name = `metlo-health-check-${id}`
    let resp = await conn.create_health_check({
        healthCheckName: health_check_name,
    })
    await wait_for_global_operation(resp[0].latestResponse.name, conn)
    return {
        //@ts-ignore
        healthCheckUrl: resp[0].latestResponse.targetLink,
    }

}

const createBackendService = async (
    conn: GCP_CONN,
    network_url,
    managed_group_url,
    health_check_url,
    id) => {
    const backend_name = `metlo-backend-${id}`
    let resp = await conn.create_backend_service({
        networkURL: network_url,
        managedGroupURL: managed_group_url,
        healthCheckURL: health_check_url,
        name: backend_name,
    })
    await wait_for_regional_operation(resp[0].latestResponse.name, conn)
    return {
        //@ts-ignore
        backendServiceUrl: resp[0].latestResponse.targetLink,
    }

}

const createLoadBalancer = async (
    conn: GCP_CONN,
    network_url,
    destination_subnetwork_url,
    backend_service_url,
    id) => {

    const rule_name = `metlo-forwarding-rule-${id}`
    let resp = await conn.create_forwarding_rule({
        networkURL: network_url,
        name: rule_name,
        subnetURL: destination_subnetwork_url,
        backendServiceURL: backend_service_url,
    })
    await wait_for_regional_operation(resp[0].latestResponse.name, conn)
    return {
        //@ts-ignore
        forwardingRuleUrl: resp[0].latestResponse.targetLink,
    }
}

const packetMirroring = async (
    conn: GCP_CONN,
    network_url,
    forwarding_rule_url,
    source_instance_url,
    mirror_source_value,
    source_type,
    id
) => {
    const packet_mirror_name = `metlo-packet-mirroring-${id}`
    var packet_mirror_url
    if (source_type === "INSTANCE") {
        let resp = await conn.start_packet_mirroring({
            networkURL: network_url,
            name: packet_mirror_name,
            mirroredInstanceURLs: [source_instance_url],
            loadBalancerURL: forwarding_rule_url,
        })
        packet_mirror_url = (
            await wait_for_regional_operation(resp[0].latestResponse.name, conn)
        )[0].targetLink
    } else if (source_type === "SUBNET") {
        let resp = await conn.start_packet_mirroring({
            networkURL: network_url,
            name: packet_mirror_name,
            mirroredSubnetURLS: [source_instance_url],
            loadBalancerURL: forwarding_rule_url,
        })
        packet_mirror_url = (
            await wait_for_regional_operation(resp[0].latestResponse.name, conn)
        )[0].targetLink
    } else if (source_type === "TAG") {
        let resp = await conn.start_packet_mirroring({
            networkURL: network_url,
            name: packet_mirror_name,
            mirroredTagURLs: mirror_source_value,
            loadBalancerURL: forwarding_rule_url,
        })
        packet_mirror_url = (
            await wait_for_regional_operation(resp[0].latestResponse.name, conn)
        )[0].targetLink
    }
    return {}

}

const imageURL = "https://www.googleapis.com/compute/v1/projects/metlo-security/global/images/metlo-ingestor-v1"

export const gcpTrafficMirrorSetup = async () => {
    const id = uuidv4()
    try {
        const { project, zone, network, key } = await verifyAccountDetails()
        const networkUrl = `https://www.googleapis.com/compute/v1/projects/${project}/global/networks/${network}`
        const conn = new GCP_CONN(key, zone, project);

        const { sourceType, sourceInstanceURL, sourcePrivateIP, sourceSubnetworkURL, sourceTag } = await sourceSelection(conn)
        const { ipRange, destinationSubnetworkUrl } = await getDestinationSubnet(conn, networkUrl, id)
        const { firewallRuleUrl } = await createFirewallRule(conn, networkUrl, ipRange, id)
        const { routerURL } = await createCloudRouter(conn, networkUrl, destinationSubnetworkUrl, id)
        const { imageTemplateUrl, instanceGroupName, instanceUrl } = await create_mig(conn, networkUrl, destinationSubnetworkUrl, imageURL, id)
        const managedGroupUrl = `https://www.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instanceGroups/${instanceGroupName}`
        const { healthCheckUrl } = await createHealthCheck(conn, id)
        const { backendServiceUrl } = await createBackendService(conn, networkUrl, managedGroupUrl, healthCheckUrl, id)
        const { forwardingRuleUrl } = await createLoadBalancer(conn, networkUrl, destinationSubnetworkUrl, backendServiceUrl, id)
        const { } = await packetMirroring(conn, networkUrl, forwardingRuleUrl, sourceInstanceURL, sourceTag, sourceType, id)

    } catch (e) {
        console.log(e)
    }
}

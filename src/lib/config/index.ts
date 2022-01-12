import localConfig from "./config.json"

/**
 * TYPES
 */

export enum Network {
    MAINNET = 1,
    POLYGON = 137,
}

export interface NetworkConfig {
    chainId: Network,
    chainName: string,
    name: string,
    network: string,
    rpc: string,
    ws: string,
    addresses: {
        exchangeProxy: string;
        merkleRedeem: string;
        merkleOrchard: string;
        multicall: string;
        vault: string;
        weightedPoolFactory: string;
        stablePoolFactory: string;
        weth: string;
        stETH: string;
        wstETH: string;
        lidoRelayer: string;
        balancerHelpers: string;
        batchRelayer: string;
    };
}

export interface Config {
    ipfsGateway: string,
    networks: Record<string,NetworkConfig>,
}

const config : Config = localConfig['config'];

export default config;

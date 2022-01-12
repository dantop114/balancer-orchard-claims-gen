import { Contract } from '@ethersproject/contracts';
import { Interface } from '@ethersproject/abi';

import config from "../config"
import { JsonRpcProvider } from '@ethersproject/providers';

export async function multicall<T>(
    network: string,
    provider: JsonRpcProvider,
    abi: any[],
    calls: any[],
    options: any = {},
    requireSuccess = false
): Promise<(T | null)[]> {
    const multi = new Contract(
        config.networks[network].addresses.multicall,
        [
            'function tryAggregate(bool requireSuccess, tuple(address, bytes)[] memory calls) public view returns (tuple(bool, bytes)[] memory returnData)'
        ],
        provider
    );
    const itf = new Interface(abi);
    try {
        const res: [boolean, string][] = await multi.tryAggregate(
            // if false, allows individual calls to fail without causing entire multicall to fail
            requireSuccess,
            calls.map(call => [
                call[0].toLowerCase(),
                itf.encodeFunctionData(call[1], call[2])
            ]),
            options
        );

        return res.map(([success, returnData], i) => {
            if (!success) return null;
            const decodedResult = itf.decodeFunctionResult(calls[i][1], returnData);
            // Automatically unwrap any simple return values
            return decodedResult.length > 1 ? decodedResult : decodedResult[0];
        });
    } catch (e) {
        return Promise.reject(e);
    }
}

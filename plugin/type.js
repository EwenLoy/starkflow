"use strict";

{
	const SDK = globalThis.SDK;

	const PLUGIN_CLASS = SDK.Plugins.StarkFlow;

	PLUGIN_CLASS.Type = class StarkFlowType extends SDK.ITypeBase
	{
		constructor(sdkPlugin, iObjectType)
		{
			super(sdkPlugin, iObjectType);
		}
	};
}

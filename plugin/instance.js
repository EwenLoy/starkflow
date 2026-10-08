"use strict";

{
	const SDK = globalThis.SDK;

	const PLUGIN_CLASS = SDK.Plugins.StarkFlow;

	PLUGIN_CLASS.Instance = class StarkFlowInstance extends SDK.IInstanceBase
	{
		constructor(sdkType, inst)
		{
			super(sdkType, inst);
		}

		Release()
		{
		}

		OnCreate()
		{
		}

		OnPropertyChanged(id, value)
		{
		}

		LoadC2Property(name, valueString)
		{
			return false;		// not handled
		}
	};
}

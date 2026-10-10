"use strict";

{
	const SDK = globalThis.SDK;

	const PLUGIN_ID = "EwenLoy_StarkFlow";
	const PLUGIN_CATEGORY = "web";

	const PLUGIN_CLASS = SDK.Plugins.EwenLoy_StarkFlow = class StarkFlowPlugin extends SDK.IPluginBase
	{
		constructor()
		{
			super(PLUGIN_ID);

			SDK.Lang.PushContext("plugins." + PLUGIN_ID.toLowerCase());

			this._info.SetName(lang(".name"));
			this._info.SetDescription(lang(".description"));
			this._info.SetCategory(PLUGIN_CATEGORY);
			this._info.SetAuthor("EwenLoy");
			this._info.SetHelpUrl(lang(".help-url"));
			this._info.SetIcon("icon.svg", "image/svg+xml");
			this._info.SetIsSingleGlobal(true);

			// The order here must match the order read in c3runtime/instance.js.
			SDK.Lang.PushContext(".properties");
			this._info.SetProperties([
				new SDK.PluginProperty("text", "server-url", "ws://localhost:8080/ws"),
				new SDK.PluginProperty("text", "app-id", "default"),
				new SDK.PluginProperty("combo", "log-level", { initialValue: "info", items: ["debug", "info", "warn", "error", "off"] }),
				new SDK.PluginProperty("check", "auto-reconnect", true),
				new SDK.PluginProperty("check", "replay-players", true),
				new SDK.PluginProperty("combo", "send-rate", { initialValue: "medium", items: ["fast", "medium", "slow"] })
			]);
			SDK.Lang.PopContext();		// .properties

			SDK.Lang.PopContext();
		}
	};
	PLUGIN_CLASS.Register(PLUGIN_ID, PLUGIN_CLASS);
}

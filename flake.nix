{
  description = "Agent Treasury — fully local AI agent escrow demo (Next.js + SQLite, NixOS-native)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      # Dev shell: `nix develop` gives you Node 22, SQLite (CLI + lib) and
      # Foundry. No Postgres, no Docker required.
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ nodejs_22 sqlite foundry ];
          shellHook = ''
            echo "Agent Treasury — Nix dev shell (SQLite, no Postgres)"
            echo "  npm ci"
            echo "  npm run dev     # http://localhost:3000"
            echo "  npm run test"
            echo "  (cd contracts && forge test)"
          '';
        };
      });

      # NixOS module: run the app as a systemd service from a checkout.
      # Build/run with:
      #   git clone <repo> /srv/agent-treasury
      #   cd /srv/agent-treasury && npm ci && npm run build
      #   modules.services.agent-treasury.enable = true;
      nixosModules = {
        agentTreasury = { config, lib, pkgs, ... }:
          let cfg = config.services.agentTreasury;
          in {
            options.services.agentTreasury = {
              enable = lib.mkEnableOption "Agent Treasury demo service";
              checkoutDir = lib.mkOption {
                type = lib.types.path;
                default = "/srv/agent-treasury";
                description = "Checkout where `npm ci` and `npm run build` have been run.";
              };
              port = lib.mkOption { type = lib.types.port; default = 3000; };
              openFirewall = lib.mkEnableOption "open the service port";
            };
            config = lib.mkIf cfg.enable {
              systemd.services.agent-treasury = {
                description = "Agent Treasury demo";
                after = [ "network.target" ];
                wantedBy = [ "multi-user.target" ];
                environment = {
                  NODE_ENV = "production";
                  PORT = toString cfg.port;
                  DATABASE_URL = "file:/var/lib/agent-treasury/agent-treasury.db";
                  CHAIN_ID = "46630";
                  CHAIN_NAME = "Robinhood Chain Testnet";
                  RPC_URL = "https://rpc.testnet.chain.robinhood.com/rpc";
                  EXPLORER_URL = "https://explorer.testnet.chain.robinhood.com";
                  TOKEN_SYMBOL = "tWIF";
                  MOCK_WIF_ADDRESS = "0x8187DC056F36dF72694D1CA830c518FD5D542DbC";
                  JOB_ESCROW_ADDRESS = "0x64e4Ff8B86762eb363410498fEE5270A056606b4";
                  CREDIT_SHOP_ADDRESS = "0x521c5E4cD5c291283448705C9323d313CcA9d360";
                  DEMO_TOKEN_PRICE_USD = "0.02";
                };
                serviceConfig = {
                  ExecStart = "${pkgs.nodejs_22}/bin/npm --prefix ${cfg.checkoutDir} run start";
                  WorkingDirectory = cfg.checkoutDir;
                  StateDirectory = "agent-treasury";
                  DynamicUser = true;
                  Restart = "on-failure";
                };
              };
              networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
            };
          };
        default = self.nixosModules.agentTreasury;
      };
    };
}

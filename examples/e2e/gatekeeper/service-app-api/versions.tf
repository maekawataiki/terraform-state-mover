terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "local" {}
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Project = "terraform-state-mover-e2e"
      Test    = "gatekeeper"
    }
  }
}

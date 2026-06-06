provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  access_key                  = "mock"
  secret_key                  = "mock"
}

provider "aws" {
  alias                       = "prod"
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  access_key                  = "mock"
  secret_key                  = "mock"
  assume_role {
    role_arn = "arn:aws:iam::111111111111:role/terraform-prod"
  }
}

provider "aws" {
  alias                       = "staging"
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  access_key                  = "mock"
  secret_key                  = "mock"
  assume_role {
    role_arn = "arn:aws:iam::111111111111:role/terraform-staging"
  }
}

provider "aws" {
  alias                       = "shared"
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  access_key                  = "mock"
  secret_key                  = "mock"
  assume_role {
    role_arn = "arn:aws:iam::111111111111:role/terraform-shared"
  }
}

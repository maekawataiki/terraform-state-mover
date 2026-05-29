provider "aws" {
  alias  = "prod"
  region = "us-east-1"
  assume_role {
    role_arn = "arn:aws:iam::111111111111:role/terraform-prod"
  }
}

provider "aws" {
  alias  = "staging"
  region = "us-east-1"
  assume_role {
    role_arn = "arn:aws:iam::111111111111:role/terraform-staging"
  }
}

provider "aws" {
  alias  = "shared"
  region = "us-east-1"
  assume_role {
    role_arn = "arn:aws:iam::111111111111:role/terraform-shared"
  }
}
